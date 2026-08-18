import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../lib/config";
import { sanitizeError } from "../lib/errors";
import { listOrganizationRepositories } from "../lib/github-client";
import { getStore, openStore } from "../lib/store";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mirror-mirror-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject.");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runtime boundaries", () => {
  it("loads explicit runtime configuration", () => {
    const config = loadConfig({
      GITHUB_ORG: "  YumaIT  ",
      GITHUB_TOKEN: "secret-token",
      MIRROR_DATA_DIR: "./custom-mirrors",
      SYNC_INTERVAL_MINUTES: "30",
      GIT_OPERATION_TIMEOUT_MINUTES: "90",
    });

    expect(config).toEqual({
      organization: "YumaIT",
      token: "secret-token",
      dataDir: path.resolve("./custom-mirrors"),
      syncIntervalMs: 30 * 60 * 1000,
      gitOperationTimeoutMs: 90 * 60 * 1000,
    });
  });

  it("uses documented local defaults", () => {
    const config = loadConfig({
      GITHUB_ORG: "YumaIT",
      GITHUB_TOKEN: "secret-token",
    });

    expect(config.dataDir).toBe(path.resolve("./mirror-data"));
    expect(config.syncIntervalMs).toBe(60 * 60 * 1000);
    expect(config.gitOperationTimeoutMs).toBe(60 * 60 * 1000);
  });

  it.each([
    ["GITHUB_ORG", { GITHUB_TOKEN: "secret-token" }],
    ["GITHUB_ORG", { GITHUB_ORG: "   ", GITHUB_TOKEN: "secret-token" }],
    ["GITHUB_TOKEN", { GITHUB_ORG: "YumaIT" }],
    ["GITHUB_TOKEN", { GITHUB_ORG: "YumaIT", GITHUB_TOKEN: "   " }],
    [
      "SYNC_INTERVAL_MINUTES",
      {
        GITHUB_ORG: "YumaIT",
        GITHUB_TOKEN: "secret-token",
        SYNC_INTERVAL_MINUTES: "0",
      },
    ],
    [
      "SYNC_INTERVAL_MINUTES",
      {
        GITHUB_ORG: "YumaIT",
        GITHUB_TOKEN: "secret-token",
        SYNC_INTERVAL_MINUTES: "1.5",
      },
    ],
    [
      "GIT_OPERATION_TIMEOUT_MINUTES",
      {
        GITHUB_ORG: "YumaIT",
        GITHUB_TOKEN: "secret-token",
        GIT_OPERATION_TIMEOUT_MINUTES: "-1",
      },
    ],
    [
      "GIT_OPERATION_TIMEOUT_MINUTES",
      {
        GITHUB_ORG: "YumaIT",
        GITHUB_TOKEN: "secret-token",
        GIT_OPERATION_TIMEOUT_MINUTES: "not-a-number",
      },
    ],
  ])("rejects invalid %s configuration", (field, env) => {
    expect(() => loadConfig(env)).toThrow(field);
  });

  it("redacts credentials and bounds exposed errors", () => {
    const token = "secret/token?value";
    const message = [
      `request failed with ${token}`,
      `encoded ${encodeURIComponent(token)}`,
      "at https://x-access-token:another-secret@github.com/YumaIT/repo.git",
      "x".repeat(3_000),
    ].join(" ");

    const sanitized = sanitizeError(new Error(message), [token]);

    expect(sanitized).toContain("request failed");
    expect(sanitized).not.toContain(token);
    expect(sanitized).not.toContain(encodeURIComponent(token));
    expect(sanitized).not.toContain("another-secret");
    expect(sanitized.length).toBeLessThanOrEqual(2_000);
    expect(sanitizeError({ message: "not an Error" }, [token])).toBe(
      "Unexpected error.",
    );
  });
});

describe("GitHub discovery", () => {
  it("returns every valid repository kind from one page", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json([
        {
          id: 1,
          name: "private-repo",
          full_name: "YumaIT/private-repo",
          clone_url: "https://github.com/YumaIT/private-repo.git",
          private: true,
        },
        {
          id: 2,
          name: "archive",
          full_name: "YumaIT/archive",
          clone_url: "https://github.com/YumaIT/archive.git",
          archived: true,
        },
        {
          id: 3,
          name: "fork",
          full_name: "YumaIT/fork",
          clone_url: "https://github.com/YumaIT/fork.git",
          fork: true,
        },
      ]),
    );

    await expect(
      listOrganizationRepositories(
        { organization: "Yuma IT", token: "secret-token" },
        fetchImpl,
      ),
    ).resolves.toEqual([
      {
        githubId: 1,
        name: "private-repo",
        fullName: "YumaIT/private-repo",
        cloneUrl: "https://github.com/YumaIT/private-repo.git",
      },
      {
        githubId: 2,
        name: "archive",
        fullName: "YumaIT/archive",
        cloneUrl: "https://github.com/YumaIT/archive.git",
      },
      {
        githubId: 3,
        name: "fork",
        fullName: "YumaIT/fork",
        cloneUrl: "https://github.com/YumaIT/fork.git",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/orgs/Yuma%20IT/repos?type=all&per_page=100",
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer secret-token",
          "User-Agent": "mirror-mirror",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "error",
      },
    );
  });

  it("follows safe pagination and returns only the complete result", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          [
            {
              id: 1,
              name: "one",
              full_name: "YumaIT/one",
              clone_url: "https://github.com/YumaIT/one.git",
            },
          ],
          {
            headers: {
              Link: '<https://api.github.com/orgs/YumaIT/repos?type=all&per_page=100&page=2>; rel="next", <https://api.github.com/orgs/YumaIT/repos?type=all&per_page=100&page=2>; rel="last"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 2,
            name: "two",
            full_name: "YumaIT/two",
            clone_url: "https://github.com/YumaIT/two.git",
          },
        ]),
      );

    await expect(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        fetchImpl,
      ),
    ).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("follows GitHub's canonical id-based pagination link", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          [
            {
              id: 1,
              name: "one",
              full_name: "YumaIT/one",
              clone_url: "https://github.com/YumaIT/one.git",
            },
          ],
          {
            headers: {
              Link: '<https://api.github.com/organizations/9950313/repos?type=all&per_page=100&page=2>; rel="next", <https://api.github.com/organizations/9950313/repos?type=all&per_page=100&page=3>; rel="last"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          [
            {
              id: 2,
              name: "two",
              full_name: "YumaIT/two",
              clone_url: "https://github.com/YumaIT/two.git",
            },
          ],
          {
            headers: {
              Link: '<https://api.github.com/organizations/9950313/repos?type=all&per_page=100&page=1>; rel="prev", <https://api.github.com/organizations/9950313/repos?type=all&per_page=100&page=3>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 3,
            name: "three",
            full_name: "YumaIT/three",
            clone_url: "https://github.com/YumaIT/three.git",
          },
        ]),
      );

    await expect(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        fetchImpl,
      ),
    ).resolves.toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects a pagination link that switches to another organization id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([], {
          headers: {
            Link: '<https://api.github.com/organizations/9950313/repos?type=all&per_page=100&page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json([], {
          headers: {
            Link: '<https://api.github.com/organizations/6154722/repos?type=all&per_page=100&page=3>; rel="next"',
          },
        }),
      );

    await expect(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        fetchImpl,
      ),
    ).rejects.toThrow("pagination URL for a different organization");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["non-array page", () => Response.json({ repositories: [] })],
    ["invalid JSON", () => new Response("{", { status: 200 })],
    [
      "invalid repository id",
      () =>
        Response.json([
          {
            id: 0,
            name: "bad",
            full_name: "YumaIT/bad",
            clone_url: "https://github.com/YumaIT/bad.git",
          },
        ]),
    ],
    [
      "credential-bearing clone URL",
      () =>
        Response.json([
          {
            id: 1,
            name: "bad",
            full_name: "YumaIT/bad",
            clone_url: "https://secret@github.com/YumaIT/bad.git",
          },
        ]),
    ],
  ])("rejects a complete result for %s", async (_label, responseFactory) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(responseFactory());

    await expect(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        fetchImpl,
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate ids discovered on a later page", async () => {
    const repository = {
      id: 1,
      name: "one",
      full_name: "YumaIT/one",
      clone_url: "https://github.com/YumaIT/one.git",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([repository], {
          headers: {
            Link: '<https://api.github.com/orgs/YumaIT/repos?page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(Response.json([repository]));

    await expect(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        fetchImpl,
      ),
    ).rejects.toThrow("duplicate repository id 1");
  });

  it.each([
    [
      "off-origin",
      "https://example.com/orgs/YumaIT/repos?page=2",
    ],
    [
      "user-info",
      "https://secret@api.github.com/orgs/YumaIT/repos?page=2",
    ],
    [
      "wrong organization path",
      "https://api.github.com/orgs/SomeoneElse/repos?page=2",
    ],
  ])("rejects a %s next link before another authenticated request", async (
    _label,
    nextUrl,
  ) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json([], {
        headers: { Link: `<${nextUrl}>; rel="next"` },
      }),
    );

    await expect(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        fetchImpl,
      ),
    ).rejects.toThrow("unsafe pagination URL");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects and cyclic pagination", async () => {
    const redirectingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/steal" },
        }),
      );
    await expect(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        redirectingFetch,
      ),
    ).rejects.toThrow("redirect");

    const firstUrl =
      "https://api.github.com/orgs/YumaIT/repos?type=all&per_page=100";
    const cyclicFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json([], {
        headers: { Link: `<${firstUrl}>; rel="next"` },
      }),
    );
    await expect(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        cyclicFetch,
      ),
    ).rejects.toThrow("cyclic pagination");
    expect(cyclicFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "HTTP 401"],
    [403, "HTTP 403"],
    [404, "HTTP 404"],
  ])("classifies GitHub HTTP %i responses", async (status, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status,
        headers: {
          "x-github-request-id": "request-123",
          "x-ratelimit-reset": "1784516400",
        },
      }),
    );

    const message = await rejectionMessage(
      listOrganizationRepositories(
        { organization: "YumaIT", token: "secret-token" },
        fetchImpl,
      ),
    );
    expect(message).toContain(expected);
    expect(message).toContain("request-123");
    expect(message).toContain("1784516400");
  });

  it("sanitizes credentials from transport failures", async () => {
    const token = "secret/token";
    const authorization = `Bearer ${token}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(
          `socket failed for ${token}; Authorization: ${authorization}`,
        ),
      );

    const message = await rejectionMessage(
      listOrganizationRepositories(
        { organization: "YumaIT", token },
        fetchImpl,
      ),
    );
    expect(message).toContain("socket failed");
    expect(message).not.toContain(token);
    expect(message).not.toContain(authorization);
  });
});

describe("mirror store", () => {
  it("migrates version-one data in place and reopens at version two", async () => {
    const dataDir = await createTemporaryDirectory();
    const databasePath = path.join(dataDir, "mirrormirror.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE repositories (
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
        updated_at TEXT NOT NULL
      );
      CREATE TABLE scheduled_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE scheduled_cycle_members (
        cycle_id INTEGER NOT NULL REFERENCES scheduled_cycles(id) ON DELETE CASCADE,
        github_id INTEGER NOT NULL REFERENCES repositories(github_id) ON DELETE RESTRICT,
        completed_at TEXT,
        PRIMARY KEY (cycle_id, github_id)
      );
      CREATE TABLE runtime_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_scheduled_at TEXT,
        discovery_error TEXT,
        worker_heartbeat_at TEXT,
        active_cycle_id INTEGER REFERENCES scheduled_cycles(id)
      );
      INSERT INTO repositories (
        github_id, name, full_name, clone_url, mirror_path, is_available,
        state, last_attempt_at, last_success_at, updated_at
      ) VALUES (
        88, 'legacy', 'YumaIT/legacy',
        'https://github.com/YumaIT/legacy.git',
        '${path.join(dataDir, "mirrors", "88.git").replaceAll("'", "''")}',
        1, 'healthy', '2026-07-19T23:00:00.000Z',
        '2026-07-19T23:01:00.000Z', '2026-07-19T23:01:00.000Z'
      );
      INSERT INTO repositories (
        github_id, name, full_name, clone_url, mirror_path, is_available,
        state, queued_at, updated_at
      ) VALUES (
        89, 'queued', 'YumaIT/queued',
        'https://github.com/YumaIT/queued.git',
        '${path.join(dataDir, "mirrors", "89.git").replaceAll("'", "''")}',
        1, 'queued', '2026-07-19T23:02:00.000Z',
        '2026-07-19T23:02:00.000Z'
      );
      INSERT INTO runtime_state (
        singleton, next_scheduled_at, worker_heartbeat_at
      ) VALUES (
        1, '2026-07-20T01:00:00.000Z', '2026-07-19T23:01:30.000Z'
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = openStore(dataDir);
    expect(
      migrated.getDashboardSnapshot(
        new Date("2026-07-19T23:01:31.000Z"),
        30_000,
      ),
    ).toMatchObject({
      repositories: [
        {
          repositoryId: 88,
          status: "healthy",
          sizeBytes: null,
          lastAttemptAt: "2026-07-19T23:00:00.000Z",
          lastSuccessAt: "2026-07-19T23:01:00.000Z",
        },
        {
          repositoryId: 89,
          status: "queued",
          sizeBytes: null,
        },
      ],
      scheduler: { nextScheduledAt: "2026-07-20T01:00:00.000Z" },
    });
    migrated.close();

    const reopened = openStore(dataDir);
    reopened.close();
    const inspected = new DatabaseSync(databasePath);
    expect(
      inspected.prepare("PRAGMA user_version").get(),
    ).toEqual({ user_version: 2 });
    expect(
      inspected
        .prepare("PRAGMA table_info(repositories)")
        .all()
        .some((column) => column.name === "mirror_size_bytes"),
    ).toBe(true);
    inspected.close();
  });

  it("rejects unsupported future schemas without changing their version", async () => {
    const dataDir = await createTemporaryDirectory();
    const databasePath = path.join(dataDir, "mirrormirror.db");
    const future = new DatabaseSync(databasePath);
    future.exec("PRAGMA user_version = 3;");
    future.close();

    expect(() => openStore(dataDir)).toThrow(
      "Unsupported database schema version 3",
    );
    const inspected = new DatabaseSync(databasePath);
    expect(inspected.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 3,
    });
    expect(inspected.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "delete",
    });
    inspected.close();
  });

  it("persists the last successful mirror size without polling the filesystem", async () => {
    const dataDir = await createTemporaryDirectory();
    const store = openStore(dataDir);
    const discoveredAt = new Date("2026-07-20T00:00:00.000Z");
    store.reconcileRepositories(
      [
        {
          githubId: 12,
          name: "sized",
          fullName: "YumaIT/sized",
          cloneUrl: "https://github.com/YumaIT/sized.git",
        },
      ],
      discoveredAt,
    );

    const job = store.claimNextManual(
      new Date("2026-07-20T00:01:00.000Z"),
    );
    expect(job?.repositoryId).toBe(12);
    store.completeSync(
      12,
      { success: true, sizeBytes: 1_536 },
      new Date("2026-07-20T00:02:00.000Z"),
    );

    await mkdir(job!.mirrorPath, { recursive: true });
    await writeFile(path.join(job!.mirrorPath, "different-size"), "tiny");
    expect(
      store.getDashboardSnapshot(
        new Date("2026-07-20T00:02:01.000Z"),
        30_000,
      ).repositories[0]?.sizeBytes,
    ).toBe(1_536);

    store.enqueueRepository(12, new Date("2026-07-20T00:03:00.000Z"));
    store.claimNextManual(new Date("2026-07-20T00:04:00.000Z"));
    store.completeSync(
      12,
      { success: false, error: "network unavailable" },
      new Date("2026-07-20T00:05:00.000Z"),
    );
    await writeFile(path.join(job!.mirrorPath, "changed-again"), "more bytes");

    expect(
      store.getDashboardSnapshot(
        new Date("2026-07-20T00:05:01.000Z"),
        30_000,
      ).repositories[0],
    ).toMatchObject({ status: "failed", sizeBytes: 1_536 });

    store.enqueueRepository(12, new Date("2026-07-20T00:06:00.000Z"));
    store.claimNextManual(new Date("2026-07-20T00:07:00.000Z"));
    expect(() =>
      store.completeSync(
        12,
        { success: true, sizeBytes: -1 },
        new Date("2026-07-20T00:08:00.000Z"),
      ),
    ).toThrow("non-negative safe integer");
    expect(() =>
      store.completeSync(
        12,
        { success: true, sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
        new Date("2026-07-20T00:08:00.000Z"),
      ),
    ).toThrow("non-negative safe integer");
    expect(
      store.getDashboardSnapshot(
        new Date("2026-07-20T00:08:01.000Z"),
        30_000,
      ).repositories[0],
    ).toMatchObject({ status: "syncing", sizeBytes: 1_536 });
    store.close();
  });

  it("persists newly discovered repositories for the dashboard", async () => {
    const dataDir = await createTemporaryDirectory();
    const now = new Date("2026-07-20T01:02:03.000Z");
    const store = openStore(dataDir);

    expect(
      store.reconcileRepositories(
        [
          {
            githubId: 42,
            name: "mirror-mirror",
            fullName: "YumaIT/mirror-mirror",
            cloneUrl: "https://github.com/YumaIT/mirror-mirror.git",
          },
        ],
        now,
      ),
    ).toEqual({ discovered: 1, newlyQueued: 1 });
    store.close();

    const reopened = openStore(dataDir);
    expect(reopened.getDashboardSnapshot(now, 30_000)).toEqual({
      repositories: [
        {
          repositoryId: 42,
          name: "mirror-mirror",
          fullName: "YumaIT/mirror-mirror",
          status: "queued",
          sizeBytes: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          latestError: null,
        },
      ],
      scheduler: {
        nextScheduledAt: null,
        discoveryError: null,
      },
      worker: {
        status: "offline",
        lastHeartbeatAt: null,
      },
    });
    reopened.close();
  });

  it("reconciles complete discovery only and clears recovered errors", async () => {
    const dataDir = await createTemporaryDirectory();
    const store = openStore(dataDir);
    const firstSeenAt = new Date("2026-07-20T02:00:00.000Z");
    store.reconcileRepositories(
      [
        {
          githubId: 1,
          name: "first",
          fullName: "YumaIT/first",
          cloneUrl: "https://github.com/YumaIT/first.git",
        },
        {
          githubId: 2,
          name: "second",
          fullName: "YumaIT/second",
          cloneUrl: "https://github.com/YumaIT/second.git",
        },
      ],
      firstSeenAt,
    );

    const repositoriesBeforeFailure = store.getDashboardSnapshot(
      new Date("2026-07-20T02:04:59.000Z"),
      30_000,
    ).repositories;
    store.recordDiscoveryFailure("GitHub denied the request");
    const snapshotAfterFailure = store.getDashboardSnapshot(
      new Date("2026-07-20T02:05:00.000Z"),
      30_000,
    );
    expect(snapshotAfterFailure.repositories).toEqual(repositoriesBeforeFailure);
    expect(snapshotAfterFailure).toMatchObject({
      repositories: [
        { repositoryId: 1, status: "queued" },
        { repositoryId: 2, status: "queued" },
      ],
      scheduler: { discoveryError: "GitHub denied the request" },
    });

    store.reconcileRepositories(
      [
        {
          githubId: 1,
          name: "renamed",
          fullName: "YumaIT/renamed",
          cloneUrl: "https://github.com/YumaIT/renamed.git",
        },
      ],
      new Date("2026-07-20T02:10:00.000Z"),
    );
    store.close();

    const reopened = openStore(dataDir);
    expect(
      reopened.getDashboardSnapshot(
        new Date("2026-07-20T02:10:01.000Z"),
        30_000,
      ),
    ).toMatchObject({
      repositories: [
        {
          repositoryId: 1,
          name: "renamed",
          fullName: "YumaIT/renamed",
          status: "queued",
        },
        { repositoryId: 2, status: "queued" },
      ],
      scheduler: { discoveryError: null },
    });
    reopened.close();
  });

  it("claims work once and preserves the prior success after failure", async () => {
    const dataDir = await createTemporaryDirectory();
    const first = openStore(dataDir);
    const second = openStore(dataDir);
    const discoveredAt = new Date("2026-07-20T03:00:00.000Z");
    first.reconcileRepositories(
      [
        {
          githubId: 77,
          name: "ranger",
          fullName: "YumaIT/ranger",
          cloneUrl: "https://github.com/YumaIT/ranger.git",
        },
      ],
      discoveredAt,
    );

    const firstAttemptAt = new Date("2026-07-20T03:01:00.000Z");
    expect(first.claimNextManual(firstAttemptAt)).toMatchObject({
      repositoryId: 77,
      fullName: "YumaIT/ranger",
      cloneUrl: "https://github.com/YumaIT/ranger.git",
      mirrorPath: path.join(dataDir, "mirrors", "77.git"),
    });
    expect(second.claimNextManual(firstAttemptAt)).toBeNull();

    const firstSuccessAt = new Date("2026-07-20T03:02:00.000Z");
    first.completeSync(77, { success: true, sizeBytes: 4_096 }, firstSuccessAt);
    expect(first.enqueueRepository(77, new Date("2026-07-20T03:03:00.000Z"))).toEqual(
      { found: true, accepted: true },
    );
    expect(first.enqueueRepository(77, new Date("2026-07-20T03:03:01.000Z"))).toEqual(
      { found: true, accepted: false },
    );

    const failedAttemptAt = new Date("2026-07-20T03:04:00.000Z");
    expect(second.claimNextManual(failedAttemptAt)?.repositoryId).toBe(77);
    second.completeSync(
      77,
      { success: false, error: "network unavailable" },
      new Date("2026-07-20T03:05:00.000Z"),
    );

    expect(
      first.getDashboardSnapshot(
        new Date("2026-07-20T03:05:01.000Z"),
        30_000,
      ).repositories,
    ).toEqual([
      {
        repositoryId: 77,
        name: "ranger",
        fullName: "YumaIT/ranger",
        status: "failed",
        sizeBytes: 4_096,
        lastAttemptAt: failedAttemptAt.toISOString(),
        lastSuccessAt: firstSuccessAt.toISOString(),
        latestError: "network unavailable",
      },
    ]);

    expect(
      first.enqueueRepository(77, new Date("2026-07-20T03:06:00.000Z")),
    ).toEqual({ found: true, accepted: true });
    expect(
      first.claimNextManual(new Date("2026-07-20T03:07:00.000Z"))
        ?.repositoryId,
    ).toBe(77);
    const recoveredAt = new Date("2026-07-20T03:08:00.000Z");
    first.completeSync(77, { success: true, sizeBytes: 8_192 }, recoveredAt);
    expect(
      first.getDashboardSnapshot(recoveredAt, 30_000).repositories[0],
    ).toMatchObject({
      status: "healthy",
      sizeBytes: 8_192,
      lastSuccessAt: recoveredAt.toISOString(),
      latestError: null,
    });
    expect(first.enqueueRepository(999, failedAttemptAt)).toEqual({
      found: false,
      accepted: false,
    });

    first.close();
    second.close();
  });

  it("queues all available repositories without duplicating active work", async () => {
    const dataDir = await createTemporaryDirectory();
    const store = openStore(dataDir);
    const discoveredAt = new Date("2026-07-20T04:00:00.000Z");
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
      discoveredAt,
    );

    const firstJob = store.claimNextManual(
      new Date("2026-07-20T04:01:00.000Z"),
    );
    expect(firstJob?.repositoryId).toBe(1);
    store.completeSync(
      1,
      { success: true, sizeBytes: 100 },
      new Date("2026-07-20T04:02:00.000Z"),
    );
    expect(
      store.claimNextManual(new Date("2026-07-20T04:02:10.000Z"))
        ?.repositoryId,
    ).toBe(2);
    store.completeSync(
      2,
      { success: true, sizeBytes: 200 },
      new Date("2026-07-20T04:02:20.000Z"),
    );
    store.reconcileRepositories(
      [
        {
          githubId: 1,
          name: "one",
          fullName: "YumaIT/one",
          cloneUrl: "https://github.com/YumaIT/one.git",
        },
      ],
      new Date("2026-07-20T04:03:00.000Z"),
    );

    expect(
      store.enqueueAllAvailable(new Date("2026-07-20T04:04:00.000Z")),
    ).toEqual({ accepted: 1, alreadyActive: 0 });
    expect(
      store.enqueueAllAvailable(new Date("2026-07-20T04:05:00.000Z")),
    ).toEqual({ accepted: 0, alreadyActive: 1 });
    expect(
      store.getDashboardSnapshot(
        new Date("2026-07-20T04:05:01.000Z"),
        30_000,
      ).repositories,
    ).toMatchObject([
      { repositoryId: 1, status: "queued" },
      {
        repositoryId: 2,
        status: "unavailable",
        lastSuccessAt: "2026-07-20T04:02:20.000Z",
      },
    ]);

    store.close();
  });

  it("keeps scheduled membership fixed and defers manual requeues", async () => {
    const dataDir = await createTemporaryDirectory();
    const store = openStore(dataDir);
    const cycleStartedAt = new Date("2026-07-20T05:00:00.000Z");
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
      cycleStartedAt,
    );

    const cycle = store.beginScheduledCycle(cycleStartedAt);
    expect(cycle.memberCount).toBe(2);
    const firstJob = store.claimNextScheduled(
      cycle.cycleId,
      new Date("2026-07-20T05:01:00.000Z"),
    );
    expect(firstJob?.repositoryId).toBe(1);
    store.completeScheduledMember(
      cycle.cycleId,
      1,
      { success: true, sizeBytes: 300 },
      new Date("2026-07-20T05:02:00.000Z"),
    );
    expect(
      store.getDashboardSnapshot(
        new Date("2026-07-20T05:02:01.000Z"),
        30_000,
      ).repositories[0]?.sizeBytes,
    ).toBe(300);
    expect(
      store.enqueueRepository(1, new Date("2026-07-20T05:03:00.000Z")),
    ).toEqual({ found: true, accepted: true });
    expect(
      store.finishScheduledCycle(
        cycle.cycleId,
        new Date("2026-07-20T06:00:00.000Z"),
        new Date("2026-07-20T05:03:01.000Z"),
      ),
    ).toBe(false);

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
      new Date("2026-07-20T05:03:30.000Z"),
    );

    const secondJob = store.claimNextScheduled(
      cycle.cycleId,
      new Date("2026-07-20T05:04:00.000Z"),
    );
    expect(secondJob?.repositoryId).toBe(2);
    store.completeScheduledMember(
      cycle.cycleId,
      2,
      { success: false, error: "fetch failed" },
      new Date("2026-07-20T05:05:00.000Z"),
    );
    expect(
      store.claimNextScheduled(
        cycle.cycleId,
        new Date("2026-07-20T05:05:01.000Z"),
      ),
    ).toBeNull();
    expect(
      store.claimNextManual(new Date("2026-07-20T05:05:02.000Z")),
    ).toBeNull();

    const nextScheduledAt = new Date("2026-07-20T06:00:00.000Z");
    expect(
      store.finishScheduledCycle(
        cycle.cycleId,
        nextScheduledAt,
        new Date("2026-07-20T05:06:00.000Z"),
      ),
    ).toBe(true);
    store.close();

    const reopened = openStore(dataDir);
    expect(
      reopened.claimNextManual(new Date("2026-07-20T05:06:01.000Z"))
        ?.repositoryId,
    ).toBe(1);
    expect(
      reopened.getDashboardSnapshot(
        new Date("2026-07-20T05:06:02.000Z"),
        30_000,
      ).scheduler.nextScheduledAt,
    ).toBe(nextScheduledAt.toISOString());

    reopened.close();
  });

  it("recovers interrupted work and persists scheduler health", async () => {
    const dataDir = await createTemporaryDirectory();
    const first = openStore(dataDir);
    const startedAt = new Date("2026-07-20T07:00:00.000Z");
    first.reconcileRepositories(
      [
        {
          githubId: 9,
          name: "nine",
          fullName: "YumaIT/nine",
          cloneUrl: "https://github.com/YumaIT/nine.git",
        },
      ],
      startedAt,
    );
    const cycle = first.beginScheduledCycle(startedAt);
    expect(
      first.claimNextScheduled(
        cycle.cycleId,
        new Date("2026-07-20T07:01:00.000Z"),
      )?.repositoryId,
    ).toBe(9);
    first.writeHeartbeat(new Date("2026-07-20T07:01:05.000Z"));
    first.close();

    const reopened = openStore(dataDir);
    expect(
      reopened.recoverInterrupted(new Date("2026-07-20T07:02:00.000Z")),
    ).toBe(1);
    expect(
      reopened.claimNextScheduled(
        cycle.cycleId,
        new Date("2026-07-20T07:02:01.000Z"),
      )?.repositoryId,
    ).toBe(9);
    expect(reopened.getHealth()).toEqual({
      activeCycleId: cycle.cycleId,
      nextScheduledAt: null,
      workerHeartbeatAt: "2026-07-20T07:01:05.000Z",
    });
    expect(
      reopened.getDashboardSnapshot(
        new Date("2026-07-20T07:01:20.000Z"),
        30_000,
      ).worker.status,
    ).toBe("online");
    expect(
      reopened.getDashboardSnapshot(
        new Date("2026-07-20T07:01:00.000Z"),
        30_000,
      ).worker.status,
    ).toBe("offline");
    expect(
      reopened.getDashboardSnapshot(
        new Date("2026-07-20T07:02:00.000Z"),
        30_000,
      ).worker.status,
    ).toBe("offline");
    reopened.close();
  });

  it("caches the web store by resolved data directory", async () => {
    const dataDir = await createTemporaryDirectory();

    expect(getStore(dataDir)).toBe(getStore(path.join(dataDir, ".")));
  });
});
