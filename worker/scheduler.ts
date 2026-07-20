import type { RuntimeConfig } from "../lib/config";
import type {
  DiscoveredRepository,
  StoreHealth,
  SyncJob,
  SyncOutcome,
} from "../lib/contracts";
import { sanitizeError } from "../lib/errors";
import type { MirrorStore } from "../lib/store";

const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

export interface WorkerDependencies {
  config: RuntimeConfig;
  store: MirrorStore;
  now?: () => Date;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  discover: () => Promise<readonly DiscoveredRepository[]>;
  mirror: (repository: SyncJob, signal: AbortSignal) => Promise<number>;
}

function defaultWait(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function isDue(nextScheduledAt: string | null, now: Date): boolean {
  return nextScheduledAt === null || Date.parse(nextScheduledAt) <= now.getTime();
}

/** Report whether the worker heartbeat is present and within its stale window. */
export function isWorkerHealthy(
  health: StoreHealth,
  now: Date,
  staleAfterMs: number,
): boolean {
  if (!health.workerHeartbeatAt) {
    return false;
  }
  const heartbeatAt = Date.parse(health.workerHeartbeatAt);
  const heartbeatAge = now.getTime() - heartbeatAt;
  return (
    Number.isFinite(heartbeatAt) &&
    heartbeatAge >= 0 &&
    heartbeatAge <= staleAfterMs
  );
}

/** Run discovery, scheduled cycles, and durable manual work until aborted. */
export async function runWorker(
  dependencies: WorkerDependencies,
  signal: AbortSignal,
): Promise<void> {
  const now = dependencies.now ?? (() => new Date());
  const wait = dependencies.wait ?? defaultWait;
  const { config, store } = dependencies;
  let startupDiscoveryPending = true;

  store.recoverInterrupted(now());
  store.writeHeartbeat(now());
  const heartbeat = setInterval(() => {
    store.writeHeartbeat(now());
  }, HEARTBEAT_INTERVAL_MS);

  async function discoverRepositories(): Promise<boolean> {
    try {
      const repositories = await dependencies.discover();
      store.reconcileRepositories(repositories, now());
      return true;
    } catch (error) {
      store.recordDiscoveryFailure(sanitizeError(error, [config.token]));
      return false;
    }
  }

  async function synchronize(
    repository: SyncJob,
    cycleId: number | null,
  ): Promise<boolean> {
    let outcome: SyncOutcome;
    try {
      const sizeBytes = await dependencies.mirror(repository, signal);
      outcome = { success: true, sizeBytes };
    } catch (error) {
      if (signal.aborted) {
        store.recoverInterrupted(now());
        return false;
      }
      outcome = {
        success: false as const,
        error: sanitizeError(error, [
          config.token,
          config.dataDir,
          repository.mirrorPath,
          `${repository.mirrorPath}.tmp`,
        ]),
      };
    }

    const completedAt = now();
    if (cycleId === null) {
      store.completeSync(repository.repositoryId, outcome, completedAt);
    } else {
      store.completeScheduledMember(
        cycleId,
        repository.repositoryId,
        outcome,
        completedAt,
      );
    }
    return true;
  }

  try {
    while (!signal.aborted) {
      let health = store.getHealth();
      const scheduleIsDue = isDue(health.nextScheduledAt, now());

      if (startupDiscoveryPending) {
        const discoverySucceeded = await discoverRepositories();
        startupDiscoveryPending = false;
        if (!discoverySucceeded && health.activeCycleId === null && scheduleIsDue) {
          store.deferSchedule(new Date(now().getTime() + config.syncIntervalMs));
        }
        health = store.getHealth();
      } else if (health.activeCycleId === null && scheduleIsDue) {
        const discoverySucceeded = await discoverRepositories();
        if (!discoverySucceeded) {
          store.deferSchedule(new Date(now().getTime() + config.syncIntervalMs));
          await wait(POLL_INTERVAL_MS, signal);
          continue;
        }
        health = store.getHealth();
      }

      if (signal.aborted) {
        break;
      }

      let cycleId = health.activeCycleId;
      if (cycleId === null && isDue(health.nextScheduledAt, now())) {
        cycleId = store.beginScheduledCycle(now()).cycleId;
      }

      if (cycleId !== null) {
        // SHORTCUT: repository syncs are serial; add bounded parallelism when full-cycle duration regularly exceeds the configured interval.
        const repository = store.claimNextScheduled(cycleId, now());
        if (repository) {
          if (!(await synchronize(repository, cycleId))) {
            break;
          }
          continue;
        }
        store.finishScheduledCycle(
          cycleId,
          new Date(now().getTime() + config.syncIntervalMs),
          now(),
        );
        continue;
      }

      const manualRepository = store.claimNextManual(now());
      if (manualRepository) {
        if (!(await synchronize(manualRepository, null))) {
          break;
        }
        continue;
      }

      await wait(POLL_INTERVAL_MS, signal);
    }
  } finally {
    clearInterval(heartbeat);
    if (signal.aborted) {
      store.recoverInterrupted(now());
    }
  }
}
