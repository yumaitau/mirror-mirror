import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStore } from "../lib/store";

const temporaryDirectories: string[] = [];
const workerEntry = path.resolve("worker/index.ts");
const bunExecutable = resolveBun();

function resolveBun(): string {
  if (typeof process.versions.bun === "string") {
    return process.execPath;
  }

  const candidates = [
    process.env.BUN,
    process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, "bin", "bun")
      : undefined,
    path.join(os.homedir(), ".bun", "bin", "bun"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "bun";
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mirror-worker-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function workerEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITHUB_ORG: "YumaIT",
    GITHUB_TOKEN: "worker-cli-test-token",
    MIRROR_DATA_DIR: dataDir,
  };
}

function collectProcess(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

function runWorkerCli(
  args: string[],
  dataDir: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const child = spawn(bunExecutable, ["--bun", workerEntry, ...args], {
    env: workerEnv(dataDir),
    stdio: ["ignore", "ignore", "pipe"],
  });
  return collectProcess(child);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("worker CLI on Bun", () => {
  it("exits 0 from --check-config with valid configuration", async () => {
    const dataDir = await temporaryDirectory();
    const result = await runWorkerCli(["--check-config"], dataDir);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("exits 1 from --healthcheck when the heartbeat is missing or stale", async () => {
    const dataDir = await temporaryDirectory();
    expect((await runWorkerCli(["--check-config"], dataDir)).code).toBe(0);
    expect((await runWorkerCli(["--healthcheck"], dataDir)).code).toBe(1);

    const store = openStore(dataDir);
    store.writeHeartbeat(new Date(Date.now() - 30_001));
    store.close();

    expect((await runWorkerCli(["--healthcheck"], dataDir)).code).toBe(1);
  });

  it("exits 0 from --healthcheck when the heartbeat is fresh", async () => {
    const dataDir = await temporaryDirectory();
    const store = openStore(dataDir);
    store.writeHeartbeat(new Date());
    store.close();

    const result = await runWorkerCli(["--healthcheck"], dataDir);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("starts the default loop and exits 0 after SIGTERM", async () => {
    const dataDir = await temporaryDirectory();
    const child = spawn(bunExecutable, ["--bun", workerEntry], {
      env: workerEnv(dataDir),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const finished = collectProcess(child);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      try {
        const store = openStore(dataDir);
        const heartbeat = store.getHealth().workerHeartbeatAt;
        store.close();
        if (heartbeat) {
          break;
        }
      } catch {
        // The worker has not created the store yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    child.kill("SIGTERM");
    const result = await finished;
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  });
});
