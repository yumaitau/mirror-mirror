import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfig } from "../lib/config";
import { openStore } from "../lib/store";
import { isWorkerHealthy, runWorker } from "../worker/scheduler";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mirror-worker-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function config(dataDir: string): RuntimeConfig {
  return {
    organization: "YumaIT",
    token: "secret-token",
    dataDir,
    syncIntervalMs: 60 * 60 * 1000,
    gitOperationTimeoutMs: 10_000,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("worker scheduler", () => {
  it("reports only a fresh heartbeat as healthy", () => {
    const now = new Date("2026-07-20T08:00:30.000Z");

    expect(
      isWorkerHealthy(
        {
          activeCycleId: null,
          nextScheduledAt: null,
          workerHeartbeatAt: null,
        },
        now,
        30_000,
      ),
    ).toBe(false);
    expect(
      isWorkerHealthy(
        {
          activeCycleId: null,
          nextScheduledAt: null,
          workerHeartbeatAt: "2026-07-20T07:59:59.999Z",
        },
        now,
        30_000,
      ),
    ).toBe(false);
    expect(
      isWorkerHealthy(
        {
          activeCycleId: null,
          nextScheduledAt: null,
          workerHeartbeatAt: "2026-07-20T08:00:00.000Z",
        },
        now,
        30_000,
      ),
    ).toBe(true);
    expect(
      isWorkerHealthy(
        {
          activeCycleId: null,
          nextScheduledAt: null,
          workerHeartbeatAt: "2026-07-20T08:00:31.000Z",
        },
        now,
        30_000,
      ),
    ).toBe(false);
  });

  it("discovers and synchronizes a fixed first scheduled cycle", async () => {
    const dataDir = await temporaryDirectory();
    const store = openStore(dataDir);
    const controller = new AbortController();
    const now = new Date("2026-07-20T08:00:00.000Z");
    const synchronized: number[] = [];

    await runWorker(
      {
        config: config(dataDir),
        store,
        now: () => now,
        wait: async () => {
          controller.abort();
        },
        discover: async () => [
          {
            githubId: 1,
            name: "one",
            fullName: "YumaIT/one",
            cloneUrl: "https://github.com/YumaIT/one.git",
          },
          {
            githubId: 2,
            name: "two",
            fullName: "YumaIT/two",
            cloneUrl: "https://github.com/YumaIT/two.git",
          },
        ],
        mirror: async (repository) => {
          synchronized.push(repository.repositoryId);
          return repository.repositoryId * 1_000;
        },
      },
      controller.signal,
    );

    expect(synchronized).toEqual([1, 2]);
    expect(store.getDashboardSnapshot(now, 30_000)).toMatchObject({
      repositories: [
        {
          repositoryId: 1,
          status: "healthy",
          sizeBytes: 1_000,
          lastSuccessAt: now.toISOString(),
        },
        {
          repositoryId: 2,
          status: "healthy",
          sizeBytes: 2_000,
          lastSuccessAt: now.toISOString(),
        },
      ],
      scheduler: {
        nextScheduledAt: "2026-07-20T09:00:00.000Z",
        discoveryError: null,
      },
      worker: { status: "online", lastHeartbeatAt: now.toISOString() },
    });
    store.close();
  });

  it("syncs only a new repository when restarting before the preserved due time", async () => {
    const dataDir = await temporaryDirectory();
    const store = openStore(dataDir);
    const existingRepository = {
      githubId: 1,
      name: "one",
      fullName: "YumaIT/one",
      cloneUrl: "https://github.com/YumaIT/one.git",
    };
    const seededAt = new Date("2026-07-20T08:00:00.000Z");
    store.reconcileRepositories([existingRepository], seededAt);
    const seedCycle = store.beginScheduledCycle(seededAt);
    store.claimNextScheduled(seedCycle.cycleId, seededAt);
    store.completeScheduledMember(
      seedCycle.cycleId,
      1,
      { success: true, sizeBytes: 500 },
      seededAt,
    );
    store.finishScheduledCycle(
      seedCycle.cycleId,
      new Date("2026-07-20T10:00:00.000Z"),
      seededAt,
    );

    const controller = new AbortController();
    const restartedAt = new Date("2026-07-20T09:00:00.000Z");
    const synchronized: number[] = [];
    await runWorker(
      {
        config: config(dataDir),
        store,
        now: () => restartedAt,
        wait: async () => controller.abort(),
        discover: async () => [
          existingRepository,
          {
            githubId: 2,
            name: "two",
            fullName: "YumaIT/two",
            cloneUrl: "https://github.com/YumaIT/two.git",
          },
        ],
        mirror: async (repository) => {
          synchronized.push(repository.repositoryId);
          return repository.repositoryId * 1_000;
        },
      },
      controller.signal,
    );

    expect(synchronized).toEqual([2]);
    expect(store.getDashboardSnapshot(restartedAt, 30_000)).toMatchObject({
      repositories: [
        { repositoryId: 1, status: "healthy" },
        { repositoryId: 2, status: "healthy" },
      ],
      scheduler: { nextScheduledAt: "2026-07-20T10:00:00.000Z" },
    });
    store.close();
  });

  it("defers a failed due discovery and clears the error after recovery", async () => {
    const dataDir = await temporaryDirectory();
    const store = openStore(dataDir);
    const controller = new AbortController();
    let currentTime = new Date("2026-07-20T08:00:00.000Z");
    let waits = 0;
    const discover = vi
      .fn()
      .mockRejectedValueOnce(new Error("GitHub unavailable secret-token"))
      .mockResolvedValueOnce([
        {
          githubId: 5,
          name: "five",
          fullName: "YumaIT/five",
          cloneUrl: "https://github.com/YumaIT/five.git",
        },
      ]);

    await runWorker(
      {
        config: config(dataDir),
        store,
        now: () => currentTime,
        wait: async () => {
          waits += 1;
          if (waits === 1) {
            currentTime = new Date("2026-07-20T09:00:00.000Z");
          } else {
            controller.abort();
          }
        },
        discover,
        mirror: async () => 5_000,
      },
      controller.signal,
    );

    expect(discover).toHaveBeenCalledTimes(2);
    expect(store.getDashboardSnapshot(currentTime, 30_000)).toMatchObject({
      repositories: [{ repositoryId: 5, status: "healthy" }],
      scheduler: {
        nextScheduledAt: "2026-07-20T10:00:00.000Z",
        discoveryError: null,
      },
    });
    store.close();
  });

  it("recovers an active cycle and isolates a sanitized repository failure", async () => {
    const dataDir = await temporaryDirectory();
    const store = openStore(dataDir);
    const repositories = [
      {
        githubId: 1,
        name: "one",
        fullName: "YumaIT/one",
        cloneUrl: "https://github.com/YumaIT/one.git",
      },
      {
        githubId: 2,
        name: "two",
        fullName: "YumaIT/two",
        cloneUrl: "https://github.com/YumaIT/two.git",
      },
    ];
    const crashedAt = new Date("2026-07-20T11:00:00.000Z");
    store.reconcileRepositories(repositories, crashedAt);
    const cycle = store.beginScheduledCycle(crashedAt);
    store.claimNextScheduled(cycle.cycleId, crashedAt);

    const controller = new AbortController();
    const restartedAt = new Date("2026-07-20T11:05:00.000Z");
    const attempted: number[] = [];
    await runWorker(
      {
        config: config(dataDir),
        store,
        now: () => restartedAt,
        wait: async () => controller.abort(),
        discover: async () => repositories,
        mirror: async (repository) => {
          attempted.push(repository.repositoryId);
          if (repository.repositoryId === 1) {
            throw new Error(
              `fetch failed for ${repository.mirrorPath} with secret-token`,
            );
          }
          return 2_000;
        },
      },
      controller.signal,
    );

    expect(attempted).toEqual([2, 1]);
    const snapshot = store.getDashboardSnapshot(restartedAt, 30_000);
    expect(snapshot.repositories).toMatchObject([
      {
        repositoryId: 1,
        status: "failed",
        lastAttemptAt: restartedAt.toISOString(),
        lastSuccessAt: null,
      },
      {
        repositoryId: 2,
        status: "healthy",
        lastAttemptAt: restartedAt.toISOString(),
        lastSuccessAt: restartedAt.toISOString(),
      },
    ]);
    expect(snapshot.repositories[0]?.latestError).toContain("[REDACTED]");
    expect(snapshot.repositories[0]?.latestError).not.toContain("secret-token");
    expect(snapshot.repositories[0]?.latestError).not.toContain(dataDir);
    store.close();
  });

  it("defers an early member requeue until its scheduled cycle finishes", async () => {
    const dataDir = await temporaryDirectory();
    const store = openStore(dataDir);
    const controller = new AbortController();
    const now = new Date("2026-07-20T12:00:00.000Z");
    const synchronized: number[] = [];
    await runWorker(
      {
        config: config(dataDir),
        store,
        now: () => now,
        wait: async () => controller.abort(),
        discover: async () => [
          {
            githubId: 1,
            name: "one",
            fullName: "YumaIT/one",
            cloneUrl: "https://github.com/YumaIT/one.git",
          },
          {
            githubId: 2,
            name: "two",
            fullName: "YumaIT/two",
            cloneUrl: "https://github.com/YumaIT/two.git",
          },
        ],
        mirror: async (repository) => {
          synchronized.push(repository.repositoryId);
          if (repository.repositoryId === 2) {
            expect(store.enqueueRepository(1, now)).toEqual({
              found: true,
              accepted: true,
            });
          }
          return repository.repositoryId * 1_000;
        },
      },
      controller.signal,
    );

    expect(synchronized).toEqual([1, 2, 1]);
    expect(store.getHealth().nextScheduledAt).toBe(
      "2026-07-20T13:00:00.000Z",
    );
    store.close();
  });

  it("returns interrupted manual work to the durable queue", async () => {
    const dataDir = await temporaryDirectory();
    const store = openStore(dataDir);
    const repository = {
      githubId: 8,
      name: "eight",
      fullName: "YumaIT/eight",
      cloneUrl: "https://github.com/YumaIT/eight.git",
    };
    const now = new Date("2026-07-20T14:00:00.000Z");
    store.reconcileRepositories([repository], now);
    const initial = store.claimNextManual(now);
    expect(initial?.repositoryId).toBe(8);
    store.completeSync(8, { success: true, sizeBytes: 8_000 }, now);
    store.deferSchedule(new Date("2026-07-20T15:00:00.000Z"));
    store.enqueueRepository(8, now);

    const controller = new AbortController();
    await runWorker(
      {
        config: config(dataDir),
        store,
        now: () => now,
        discover: async () => [repository],
        mirror: async () => {
          controller.abort();
          throw new Error("aborted with secret-token");
        },
      },
      controller.signal,
    );

    expect(store.getDashboardSnapshot(now, 30_000).repositories[0]).toMatchObject({
      repositoryId: 8,
      status: "queued",
      sizeBytes: 8_000,
      lastSuccessAt: now.toISOString(),
      latestError: null,
    });
    store.close();
  });

  it("leaves a successful mirror syncing when persistence completion fails", async () => {
    const dataDir = await temporaryDirectory();
    const store = openStore(dataDir);
    const now = new Date("2026-07-20T16:00:00.000Z");
    const repository = {
      githubId: 12,
      name: "twelve",
      fullName: "YumaIT/twelve",
      cloneUrl: "https://github.com/YumaIT/twelve.git",
    };
    store.reconcileRepositories([repository], now);
    store.deferSchedule(new Date("2026-07-20T17:00:00.000Z"));
    const completionError = new Error("storage completion failed");
    const failingStore = {
      ...store,
      completeSync: vi.fn(() => {
        throw completionError;
      }),
    };

    await expect(
      runWorker(
        {
          config: config(dataDir),
          store: failingStore,
          now: () => now,
          discover: async () => [repository],
          mirror: async () => 12_000,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("storage completion failed");
    expect(failingStore.completeSync).toHaveBeenCalledOnce();
    expect(store.getDashboardSnapshot(now, 30_000).repositories[0]?.status).toBe(
      "syncing",
    );
    expect(store.recoverInterrupted(now)).toBe(1);
    expect(store.getDashboardSnapshot(now, 30_000).repositories[0]?.status).toBe(
      "queued",
    );
    store.close();
  });
});
