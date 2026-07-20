import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getHealth } from "../app/api/health/[component]/route";
import { POST as syncRepository } from "../app/api/repositories/[repositoryId]/sync/route";
import { GET as getStatus } from "../app/api/status/route";
import { POST as syncAll } from "../app/api/sync/route";
import { openStore } from "../lib/store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mirror-api-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function jsonRequest(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("GITHUB_ORG", "YumaIT");
  vi.stubEnv("GITHUB_TOKEN", "secret-token");
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("dashboard API", () => {
  it("returns persisted mirror bytes across repeated status polls", async () => {
    const dataDir = await temporaryDirectory();
    vi.stubEnv("MIRROR_DATA_DIR", dataDir);
    const store = openStore(dataDir);
    store.reconcileRepositories(
      [
        {
          githubId: 6,
          name: "six",
          fullName: "YumaIT/six",
          cloneUrl: "https://github.com/YumaIT/six.git",
        },
      ],
      new Date("2026-07-20T00:00:00.000Z"),
    );
    const job = store.claimNextManual(
      new Date("2026-07-20T00:01:00.000Z"),
    );
    store.completeSync(
      6,
      { success: true, sizeBytes: 1_536 },
      new Date("2026-07-20T00:02:00.000Z"),
    );
    store.close();

    await mkdir(job!.mirrorPath, { recursive: true });
    await writeFile(path.join(job!.mirrorPath, "different-size"), "tiny");
    const firstBody = await (await getStatus()).json();
    expect(firstBody.data.repositories[0].sizeBytes).toBe(1_536);

    await writeFile(
      path.join(job!.mirrorPath, "changed-between-polls"),
      "x".repeat(20_000),
    );
    const secondBody = await (await getStatus()).json();
    expect(secondBody.data.repositories[0].sizeBytes).toBe(1_536);
  });

  it("returns a generic envelope for unexpected storage failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dataDir = await temporaryDirectory();
    const blockedPath = path.join(dataDir, "not-a-directory");
    await writeFile(blockedPath, "blocked");
    vi.stubEnv("MIRROR_DATA_DIR", blockedPath);

    const response = await getStatus();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected server error occurred.",
      },
    });
    expect(JSON.stringify(body)).not.toContain(blockedPath);
    expect(JSON.stringify(body)).not.toContain("ENOTDIR");
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("serializes the dashboard without storage or credential details", async () => {
    const dataDir = await temporaryDirectory();
    vi.stubEnv("MIRROR_DATA_DIR", dataDir);
    const store = openStore(dataDir);
    store.reconcileRepositories(
      [
        {
          githubId: 1,
          name: "one",
          fullName: "YumaIT/one",
          cloneUrl: "https://github.com/YumaIT/one.git",
        },
      ],
      new Date("2026-07-20T01:00:00.000Z"),
    );
    store.claimNextManual(new Date("2026-07-20T01:01:00.000Z"));
    store.completeSync(
      1,
      { success: false, error: `Git failed inside ${dataDir}/mirrors/1.git` },
      new Date("2026-07-20T01:02:00.000Z"),
    );
    store.recordDiscoveryFailure(`Discovery failed inside ${dataDir}`);
    store.close();

    const response = await getStatus();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      data: {
        repositories: [
          {
            repositoryId: 1,
            fullName: "YumaIT/one",
            status: "failed",
            sizeBytes: null,
          },
        ],
      },
    });
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain(dataDir);
    expect(serialized).not.toContain("cloneUrl");
  });

  it("queues all available repositories and reports duplicate demand", async () => {
    const dataDir = await temporaryDirectory();
    vi.stubEnv("MIRROR_DATA_DIR", dataDir);
    const store = openStore(dataDir);
    store.reconcileRepositories(
      [
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
        {
          githubId: 3,
          name: "three",
          fullName: "YumaIT/three",
          cloneUrl: "https://github.com/YumaIT/three.git",
        },
      ],
      new Date(),
    );
    store.claimNextManual(new Date());
    store.completeSync(1, { success: true, sizeBytes: 1_000 }, new Date());
    store.claimNextManual(new Date());
    store.completeSync(2, { success: true, sizeBytes: 2_000 }, new Date());
    store.claimNextManual(new Date());
    store.completeSync(3, { success: true, sizeBytes: 3_000 }, new Date());
    store.enqueueRepository(2, new Date());
    store.reconcileRepositories(
      [
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
      new Date(),
    );
    store.close();

    const response = await syncAll(jsonRequest("http://localhost/api/sync"));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      data: { accepted: 1, alreadyActive: 1 },
    });

    const rejected = await syncAll(
      new Request("http://localhost/api/sync", { method: "POST" }),
    );
    expect(rejected.status).toBe(415);
    await expect(rejected.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json.",
      },
    });
  });

  it("validates, accepts, and deduplicates repository sync requests", async () => {
    const dataDir = await temporaryDirectory();
    vi.stubEnv("MIRROR_DATA_DIR", dataDir);
    const store = openStore(dataDir);
    store.reconcileRepositories(
      [
        {
          githubId: 9,
          name: "nine",
          fullName: "YumaIT/nine",
          cloneUrl: "https://github.com/YumaIT/nine.git",
        },
      ],
      new Date(),
    );
    store.claimNextManual(new Date());
    store.completeSync(9, { success: true, sizeBytes: 9_000 }, new Date());
    store.reconcileRepositories([], new Date());
    store.close();

    const accepted = await syncRepository(
      jsonRequest("http://localhost/api/repositories/9/sync"),
      { params: Promise.resolve({ repositoryId: "9" }) },
    );
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({
      data: { accepted: true },
    });

    const duplicate = await syncRepository(
      jsonRequest("http://localhost/api/repositories/9/sync"),
      { params: Promise.resolve({ repositoryId: "9" }) },
    );
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      data: { accepted: false },
    });

    for (const repositoryId of ["nope", "0", "-1", "1.5", "9007199254740992"]) {
      const invalid = await syncRepository(
        jsonRequest(`http://localhost/api/repositories/${repositoryId}/sync`),
        { params: Promise.resolve({ repositoryId }) },
      );
      expect(invalid.status).toBe(400);
    }
    const unknown = await syncRepository(
      jsonRequest("http://localhost/api/repositories/10/sync"),
      { params: Promise.resolve({ repositoryId: "10" }) },
    );
    expect(unknown.status).toBe(404);

    const nonJson = await syncRepository(
      new Request("http://localhost/api/repositories/9/sync", {
        method: "POST",
      }),
      { params: Promise.resolve({ repositoryId: "9" }) },
    );
    expect(nonJson.status).toBe(415);
  });

  it("reports web and worker health using the durable heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T04:00:30.000Z"));
    const dataDir = await temporaryDirectory();
    vi.stubEnv("MIRROR_DATA_DIR", dataDir);
    const store = openStore(dataDir);
    store.writeHeartbeat(new Date("2026-07-20T04:00:00.000Z"));
    store.close();

    const web = await getHealth(new Request("http://localhost/api/health/web"), {
      params: Promise.resolve({ component: "web" }),
    });
    expect(web.status).toBe(200);
    await expect(web.json()).resolves.toEqual({ data: { status: "healthy" } });

    const freshWorker = await getHealth(
      new Request("http://localhost/api/health/worker"),
      { params: Promise.resolve({ component: "worker" }) },
    );
    expect(freshWorker.status).toBe(200);

    vi.setSystemTime(new Date("2026-07-20T03:59:59.000Z"));
    const futureWorker = await getHealth(
      new Request("http://localhost/api/health/worker"),
      { params: Promise.resolve({ component: "worker" }) },
    );
    expect(futureWorker.status).toBe(503);

    vi.setSystemTime(new Date("2026-07-20T04:00:30.001Z"));
    const staleWorker = await getHealth(
      new Request("http://localhost/api/health/worker"),
      { params: Promise.resolve({ component: "worker" }) },
    );
    expect(staleWorker.status).toBe(503);
    await expect(staleWorker.json()).resolves.toEqual({
      error: {
        code: "WORKER_UNAVAILABLE",
        message: "The synchronization worker heartbeat is stale or missing.",
      },
    });
  });
});
