import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  DashboardSnapshot,
  DiscoveredRepository,
  RepositoryStatus,
  StoreHealth,
  SyncJob,
  SyncOutcome,
  SyncState,
} from "./contracts";

interface RepositoryRow {
  github_id: number;
  name: string;
  full_name: string;
  state: SyncState;
  is_available: number;
  mirror_size_bytes: number | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

interface RuntimeStateRow {
  next_scheduled_at: string | null;
  discovery_error: string | null;
  worker_heartbeat_at: string | null;
}

export interface MirrorStore {
  close(): void;
  reconcileRepositories(
    repositories: readonly DiscoveredRepository[],
    now: Date,
  ): { discovered: number; newlyQueued: number };
  recordDiscoveryFailure(error: string): void;
  enqueueRepository(
    repositoryId: number,
    now: Date,
  ): { found: boolean; accepted: boolean };
  enqueueAllAvailable(now: Date): { accepted: number; alreadyActive: number };
  beginScheduledCycle(now: Date): { cycleId: number; memberCount: number };
  claimNextScheduled(cycleId: number, now: Date): SyncJob | null;
  completeScheduledMember(
    cycleId: number,
    repositoryId: number,
    outcome: SyncOutcome,
    now: Date,
  ): void;
  finishScheduledCycle(
    cycleId: number,
    nextScheduledAt: Date,
    now: Date,
  ): boolean;
  deferSchedule(nextScheduledAt: Date): void;
  claimNextManual(now: Date): SyncJob | null;
  completeSync(repositoryId: number, outcome: SyncOutcome, now: Date): void;
  recoverInterrupted(now: Date): number;
  writeHeartbeat(now: Date): void;
  getHealth(): StoreHealth;
  getDashboardSnapshot(now: Date, workerStaleAfterMs: number): DashboardSnapshot;
}

function runTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function publicStatus(row: RepositoryRow): RepositoryStatus {
  if (row.state === "queued" || row.state === "syncing") {
    return row.state;
  }

  return row.is_available === 0 ? "unavailable" : row.state;
}

function validateSuccessfulOutcome(outcome: SyncOutcome): void {
  if (
    outcome.success &&
    (!Number.isSafeInteger(outcome.sizeBytes) || outcome.sizeBytes < 0)
  ) {
    throw new Error("Successful synchronization size must be a non-negative safe integer.");
  }
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  runTransaction(database, () => {
    const schema = database.prepare("PRAGMA user_version").get() as unknown as {
      user_version: number;
    };
    if (schema.user_version > 2) {
      throw new Error(
        `Unsupported database schema version ${schema.user_version}; this build supports version 2.`,
      );
    }

    if (schema.user_version === 0) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS repositories (
          github_id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          full_name TEXT NOT NULL,
          clone_url TEXT NOT NULL,
          mirror_path TEXT NOT NULL,
          is_available INTEGER NOT NULL CHECK (is_available IN (0, 1)),
          state TEXT NOT NULL CHECK (state IN ('never_synced','queued','syncing','healthy','failed')),
          queued_at TEXT,
          sync_started_at TEXT,
          last_attempt_at TEXT,
          last_success_at TEXT,
          last_error TEXT,
          mirror_size_bytes INTEGER CHECK (
            mirror_size_bytes IS NULL OR
            (typeof(mirror_size_bytes) = 'integer' AND mirror_size_bytes >= 0)
          ),
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scheduled_cycles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS scheduled_cycle_members (
          cycle_id INTEGER NOT NULL REFERENCES scheduled_cycles(id) ON DELETE CASCADE,
          github_id INTEGER NOT NULL REFERENCES repositories(github_id) ON DELETE RESTRICT,
          completed_at TEXT,
          PRIMARY KEY (cycle_id, github_id)
        );

        CREATE TABLE IF NOT EXISTS runtime_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          next_scheduled_at TEXT,
          discovery_error TEXT,
          worker_heartbeat_at TEXT,
          active_cycle_id INTEGER REFERENCES scheduled_cycles(id)
        );

        INSERT OR IGNORE INTO runtime_state (singleton) VALUES (1);
        PRAGMA user_version = 2;
      `);
      return;
    }

    if (schema.user_version === 1) {
      database.exec(`
        ALTER TABLE repositories ADD COLUMN mirror_size_bytes INTEGER CHECK (
          mirror_size_bytes IS NULL OR
          (typeof(mirror_size_bytes) = 'integer' AND mirror_size_bytes >= 0)
        );
        PRAGMA user_version = 2;
      `);
    }
  });

  database.exec("PRAGMA journal_mode = WAL;");
}

/** Open an explicitly owned MirrorMirror SQLite connection. */
export function openStore(dataDir: string): MirrorStore {
  const resolvedDataDir = path.resolve(dataDir);
  const mirrorsDir = path.join(resolvedDataDir, "mirrors");
  mkdirSync(mirrorsDir, { recursive: true });

  const database = new DatabaseSync(
    path.join(resolvedDataDir, "mirrormirror.db"),
  );
  try {
    initializeDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    close(): void {
      database.close();
    },

    reconcileRepositories(repositories, now) {
      const timestamp = now.toISOString();
      return runTransaction(database, () => {
        const existingRows = database
          .prepare(
            "SELECT github_id, state, is_available FROM repositories",
          )
          .all() as Array<{
          github_id: number;
          state: SyncState;
          is_available: number;
        }>;
        const existingById = new Map(
          existingRows.map((row) => [row.github_id, row]),
        );
        const discoveredIds = new Set<number>();
        let newlyQueued = 0;

        const insertRepository = database.prepare(`
          INSERT INTO repositories (
            github_id, name, full_name, clone_url, mirror_path,
            is_available, state, queued_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, 'queued', ?, ?)
        `);
        const updateRepository = database.prepare(`
          UPDATE repositories
          SET name = ?, full_name = ?, clone_url = ?, is_available = 1,
              state = CASE WHEN state = 'never_synced' THEN 'queued' ELSE state END,
              queued_at = CASE WHEN state = 'never_synced' THEN ? ELSE queued_at END,
              updated_at = ?
          WHERE github_id = ?
        `);
        const markUnavailable = database.prepare(`
          UPDATE repositories
          SET is_available = 0, updated_at = ?
          WHERE github_id = ?
        `);

        for (const repository of repositories) {
          discoveredIds.add(repository.githubId);
          const existing = existingById.get(repository.githubId);
          if (!existing) {
            insertRepository.run(
              repository.githubId,
              repository.name,
              repository.fullName,
              repository.cloneUrl,
              path.join(mirrorsDir, `${repository.githubId}.git`),
              timestamp,
              timestamp,
            );
            newlyQueued += 1;
            continue;
          }

          updateRepository.run(
            repository.name,
            repository.fullName,
            repository.cloneUrl,
            timestamp,
            timestamp,
            repository.githubId,
          );
          if (existing.state === "never_synced") {
            newlyQueued += 1;
          }
        }

        for (const existing of existingRows) {
          if (!discoveredIds.has(existing.github_id)) {
            markUnavailable.run(timestamp, existing.github_id);
          }
        }

        database
          .prepare(
            "UPDATE runtime_state SET discovery_error = NULL WHERE singleton = 1",
          )
          .run();

        return { discovered: repositories.length, newlyQueued };
      });
    },

    recordDiscoveryFailure(error): void {
      database
        .prepare(
          "UPDATE runtime_state SET discovery_error = ? WHERE singleton = 1",
        )
        .run(error);
    },

    enqueueRepository(repositoryId, now) {
      return runTransaction(database, () => {
        const repository = database
          .prepare("SELECT state FROM repositories WHERE github_id = ?")
          .get(repositoryId) as unknown as { state: SyncState } | undefined;
        if (!repository) {
          return { found: false, accepted: false };
        }
        if (repository.state === "queued" || repository.state === "syncing") {
          return { found: true, accepted: false };
        }

        database
          .prepare(`
            UPDATE repositories
            SET state = 'queued', queued_at = ?, sync_started_at = NULL,
                updated_at = ?
            WHERE github_id = ?
          `)
          .run(now.toISOString(), now.toISOString(), repositoryId);
        return { found: true, accepted: true };
      });
    },

    enqueueAllAvailable(now) {
      return runTransaction(database, () => {
        const active = database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM repositories
            WHERE is_available = 1 AND state IN ('queued', 'syncing')
          `)
          .get() as unknown as { count: number };
        const timestamp = now.toISOString();
        const result = database
          .prepare(`
            UPDATE repositories
            SET state = 'queued', queued_at = ?, sync_started_at = NULL,
                updated_at = ?
            WHERE is_available = 1 AND state NOT IN ('queued', 'syncing')
          `)
          .run(timestamp, timestamp);

        return {
          accepted: Number(result.changes),
          alreadyActive: active.count,
        };
      });
    },

    beginScheduledCycle(now) {
      return runTransaction(database, () => {
        const runtime = database
          .prepare(
            "SELECT active_cycle_id FROM runtime_state WHERE singleton = 1",
          )
          .get() as unknown as { active_cycle_id: number | null };
        if (runtime.active_cycle_id !== null) {
          const member = database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM scheduled_cycle_members
              WHERE cycle_id = ?
            `)
            .get(runtime.active_cycle_id) as unknown as { count: number };
          return {
            cycleId: runtime.active_cycle_id,
            memberCount: member.count,
          };
        }

        const timestamp = now.toISOString();
        const cycle = database
          .prepare("INSERT INTO scheduled_cycles (started_at) VALUES (?)")
          .run(timestamp);
        const cycleId = Number(cycle.lastInsertRowid);
        database
          .prepare(`
            INSERT INTO scheduled_cycle_members (cycle_id, github_id)
            SELECT ?, github_id
            FROM repositories
            WHERE is_available = 1
          `)
          .run(cycleId);
        database
          .prepare(`
            UPDATE repositories
            SET state = 'queued', queued_at = ?, sync_started_at = NULL,
                updated_at = ?
            WHERE github_id IN (
              SELECT github_id
              FROM scheduled_cycle_members
              WHERE cycle_id = ?
            ) AND state NOT IN ('queued', 'syncing')
          `)
          .run(timestamp, timestamp, cycleId);
        database
          .prepare(`
            UPDATE runtime_state
            SET active_cycle_id = ?
            WHERE singleton = 1
          `)
          .run(cycleId);
        const member = database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM scheduled_cycle_members
            WHERE cycle_id = ?
          `)
          .get(cycleId) as unknown as { count: number };

        return { cycleId, memberCount: member.count };
      });
    },

    claimNextScheduled(cycleId, now) {
      return runTransaction(database, () => {
        const runtime = database
          .prepare(
            "SELECT active_cycle_id FROM runtime_state WHERE singleton = 1",
          )
          .get() as unknown as { active_cycle_id: number | null };
        if (runtime.active_cycle_id !== cycleId) {
          return null;
        }

        const repository = database
          .prepare(`
            SELECT r.github_id, r.full_name, r.clone_url, r.mirror_path
            FROM scheduled_cycle_members AS member
            JOIN repositories AS r ON r.github_id = member.github_id
            WHERE member.cycle_id = ? AND member.completed_at IS NULL
              AND r.state = 'queued'
            ORDER BY r.queued_at, r.github_id
            LIMIT 1
          `)
          .get(cycleId) as unknown as
          | {
              github_id: number;
              full_name: string;
              clone_url: string;
              mirror_path: string;
            }
          | undefined;
        if (!repository) {
          return null;
        }

        const timestamp = now.toISOString();
        database
          .prepare(`
            UPDATE repositories
            SET state = 'syncing', sync_started_at = ?, last_attempt_at = ?,
                updated_at = ?
            WHERE github_id = ? AND state = 'queued'
          `)
          .run(timestamp, timestamp, timestamp, repository.github_id);

        return {
          repositoryId: repository.github_id,
          fullName: repository.full_name,
          cloneUrl: repository.clone_url,
          mirrorPath: repository.mirror_path,
        };
      });
    },

    completeScheduledMember(cycleId, repositoryId, outcome, now): void {
      validateSuccessfulOutcome(outcome);
      runTransaction(database, () => {
        const active = database
          .prepare(`
            SELECT member.completed_at, repository.state
            FROM runtime_state
            JOIN scheduled_cycle_members AS member
              ON member.cycle_id = runtime_state.active_cycle_id
            JOIN repositories AS repository
              ON repository.github_id = member.github_id
            WHERE runtime_state.singleton = 1
              AND runtime_state.active_cycle_id = ?
              AND member.github_id = ?
          `)
          .get(cycleId, repositoryId) as unknown as
          | { completed_at: string | null; state: SyncState }
          | undefined;
        if (!active || active.completed_at !== null || active.state !== "syncing") {
          throw new Error(
            `Cannot complete repository ${repositoryId}: no scheduled sync is active.`,
          );
        }

        const timestamp = now.toISOString();
        if (outcome.success) {
          database
            .prepare(`
              UPDATE repositories
              SET state = 'healthy', queued_at = NULL, sync_started_at = NULL,
                  last_success_at = ?, last_error = NULL,
                  mirror_size_bytes = ?, updated_at = ?
              WHERE github_id = ?
            `)
            .run(timestamp, outcome.sizeBytes, timestamp, repositoryId);
        } else {
          database
            .prepare(`
              UPDATE repositories
              SET state = 'failed', queued_at = NULL, sync_started_at = NULL,
                  last_error = ?, updated_at = ?
              WHERE github_id = ?
            `)
            .run(outcome.error, timestamp, repositoryId);
        }
        database
          .prepare(`
            UPDATE scheduled_cycle_members
            SET completed_at = ?
            WHERE cycle_id = ? AND github_id = ? AND completed_at IS NULL
          `)
          .run(timestamp, cycleId, repositoryId);
      });
    },

    finishScheduledCycle(cycleId, nextScheduledAt, now) {
      return runTransaction(database, () => {
        const runtime = database
          .prepare(
            "SELECT active_cycle_id FROM runtime_state WHERE singleton = 1",
          )
          .get() as unknown as { active_cycle_id: number | null };
        if (runtime.active_cycle_id !== cycleId) {
          return false;
        }
        const pending = database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM scheduled_cycle_members
            WHERE cycle_id = ? AND completed_at IS NULL
          `)
          .get(cycleId) as unknown as { count: number };
        if (pending.count > 0) {
          return false;
        }

        const timestamp = now.toISOString();
        database
          .prepare(
            "UPDATE scheduled_cycles SET completed_at = ? WHERE id = ?",
          )
          .run(timestamp, cycleId);
        database
          .prepare(`
            UPDATE runtime_state
            SET active_cycle_id = NULL, next_scheduled_at = ?
            WHERE singleton = 1 AND active_cycle_id = ?
          `)
          .run(nextScheduledAt.toISOString(), cycleId);
        return true;
      });
    },

    deferSchedule(nextScheduledAt): void {
      database
        .prepare(`
          UPDATE runtime_state
          SET next_scheduled_at = ?
          WHERE singleton = 1 AND active_cycle_id IS NULL
        `)
        .run(nextScheduledAt.toISOString());
    },

    claimNextManual(now) {
      return runTransaction(database, () => {
        const runtime = database
          .prepare(
            "SELECT active_cycle_id FROM runtime_state WHERE singleton = 1",
          )
          .get() as unknown as { active_cycle_id: number | null };
        if (runtime.active_cycle_id !== null) {
          return null;
        }

        const repository = database
          .prepare(`
            SELECT github_id, full_name, clone_url, mirror_path
            FROM repositories
            WHERE state = 'queued'
            ORDER BY queued_at, github_id
            LIMIT 1
          `)
          .get() as unknown as
          | {
              github_id: number;
              full_name: string;
              clone_url: string;
              mirror_path: string;
            }
          | undefined;
        if (!repository) {
          return null;
        }

        const timestamp = now.toISOString();
        database
          .prepare(`
            UPDATE repositories
            SET state = 'syncing', sync_started_at = ?, last_attempt_at = ?,
                updated_at = ?
            WHERE github_id = ? AND state = 'queued'
          `)
          .run(timestamp, timestamp, timestamp, repository.github_id);

        return {
          repositoryId: repository.github_id,
          fullName: repository.full_name,
          cloneUrl: repository.clone_url,
          mirrorPath: repository.mirror_path,
        };
      });
    },

    completeSync(repositoryId, outcome, now): void {
      validateSuccessfulOutcome(outcome);
      runTransaction(database, () => {
        const repository = database
          .prepare("SELECT state FROM repositories WHERE github_id = ?")
          .get(repositoryId) as unknown as { state: SyncState } | undefined;
        if (!repository || repository.state !== "syncing") {
          throw new Error(
            `Cannot complete repository ${repositoryId}: no sync is active.`,
          );
        }

        const timestamp = now.toISOString();
        if (outcome.success) {
          database
            .prepare(`
              UPDATE repositories
              SET state = 'healthy', queued_at = NULL, sync_started_at = NULL,
                  last_success_at = ?, last_error = NULL,
                  mirror_size_bytes = ?, updated_at = ?
              WHERE github_id = ?
            `)
            .run(timestamp, outcome.sizeBytes, timestamp, repositoryId);
          return;
        }

        database
          .prepare(`
            UPDATE repositories
            SET state = 'failed', queued_at = NULL, sync_started_at = NULL,
                last_error = ?, updated_at = ?
            WHERE github_id = ?
          `)
          .run(outcome.error, timestamp, repositoryId);
      });
    },

    recoverInterrupted(now): number {
      const timestamp = now.toISOString();
      const result = database
        .prepare(`
          UPDATE repositories
          SET state = 'queued', queued_at = ?, sync_started_at = NULL,
              updated_at = ?
          WHERE state = 'syncing'
        `)
        .run(timestamp, timestamp);
      return Number(result.changes);
    },

    writeHeartbeat(now): void {
      database
        .prepare(`
          UPDATE runtime_state
          SET worker_heartbeat_at = ?
          WHERE singleton = 1
        `)
        .run(now.toISOString());
    },

    getHealth(): StoreHealth {
      const runtime = database
        .prepare(`
          SELECT active_cycle_id, next_scheduled_at, worker_heartbeat_at
          FROM runtime_state
          WHERE singleton = 1
        `)
        .get() as unknown as {
        active_cycle_id: number | null;
        next_scheduled_at: string | null;
        worker_heartbeat_at: string | null;
      };
      return {
        activeCycleId: runtime.active_cycle_id,
        nextScheduledAt: runtime.next_scheduled_at,
        workerHeartbeatAt: runtime.worker_heartbeat_at,
      };
    },

    getDashboardSnapshot(now, workerStaleAfterMs) {
      const repositories = database
        .prepare(`
          SELECT github_id, name, full_name, state, is_available,
                 mirror_size_bytes, last_attempt_at, last_success_at, last_error
          FROM repositories
          ORDER BY full_name COLLATE NOCASE, github_id
        `)
        .all() as unknown as RepositoryRow[];
      const runtime = database
        .prepare(`
          SELECT next_scheduled_at, discovery_error, worker_heartbeat_at
          FROM runtime_state
          WHERE singleton = 1
        `)
        .get() as unknown as RuntimeStateRow;
      const heartbeatTime = runtime.worker_heartbeat_at
        ? Date.parse(runtime.worker_heartbeat_at)
        : Number.NaN;
      const heartbeatAge = now.getTime() - heartbeatTime;
      const workerIsOnline =
        Number.isFinite(heartbeatTime) &&
        heartbeatAge >= 0 &&
        heartbeatAge <= workerStaleAfterMs;

      return {
        repositories: repositories.map((repository) => ({
          repositoryId: repository.github_id,
          name: repository.name,
          fullName: repository.full_name,
          status: publicStatus(repository),
          sizeBytes: repository.mirror_size_bytes,
          lastAttemptAt: repository.last_attempt_at,
          lastSuccessAt: repository.last_success_at,
          latestError: repository.last_error,
        })),
        scheduler: {
          nextScheduledAt: runtime.next_scheduled_at,
          discoveryError: runtime.discovery_error,
        },
        worker: {
          status: workerIsOnline ? "online" : "offline",
          lastHeartbeatAt: runtime.worker_heartbeat_at,
        },
      };
    },
  };
}

const cachedStores = new Map<string, MirrorStore>();

/** Reuse one SQLite connection for the web process polling hot path. */
export function getStore(dataDir: string): MirrorStore {
  const resolvedDataDir = path.resolve(dataDir);
  const existing = cachedStores.get(resolvedDataDir);
  if (existing) {
    return existing;
  }

  const store = openStore(resolvedDataDir);
  cachedStores.set(resolvedDataDir, store);
  return store;
}
