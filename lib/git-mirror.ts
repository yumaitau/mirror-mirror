import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { SyncJob } from "./contracts";
import { sanitizeError } from "./errors";

export interface GitMirrorConfig {
  dataDir: string;
  token: string;
  gitOperationTimeoutMs: number;
}

export interface GitMirrorOptions {
  askPassPath?: string;
  signal?: AbortSignal;
}

const MAX_STDERR_LENGTH = 16_000;

function trustedLfsUrl(cloneUrl: string): string {
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    if (!path.isAbsolute(cloneUrl)) {
      throw new Error("Refusing an unsafe repository clone URL.");
    }
    return pathToFileURL(cloneUrl).href;
  }

  if (
    url.protocol === "file:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  ) {
    return url.href;
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/[^/]+\/[^/]+\.git$/.test(url.pathname)
  ) {
    throw new Error("Refusing an unsafe repository clone URL.");
  }

  return `${url.href}/info/lfs`;
}

function runGit(
  args: readonly string[],
  config: GitMirrorConfig,
  askPassPath: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      env: {
        ...process.env,
        GIT_ASKPASS: askPassPath,
        GIT_TERMINAL_PROMPT: "0",
        GITHUB_TOKEN: config.token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const abort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
    };
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) {
      abort();
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, config.gitOperationTimeoutMs);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code, terminationSignal) => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", abort);
      if (aborted) {
        reject(new Error("Git operation aborted."));
        return;
      }
      if (timedOut) {
        reject(
          new Error(
            `Git operation timed out after ${config.gitOperationTimeoutMs}ms.`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail =
        stderr.trim() || `process exited with ${code ?? terminationSignal}`;
      reject(new Error(`Git operation failed: ${detail}`));
    });
  });
}

function clonePaths(repository: SyncJob, dataDir: string): {
  mirrorsRoot: string;
  finalPath: string;
  temporaryPath: string;
} {
  const finalPath = path.resolve(repository.mirrorPath);
  const mirrorsRoot = path.dirname(finalPath);
  const configuredMirrorsRoot = path.join(path.resolve(dataDir), "mirrors");
  if (mirrorsRoot !== configuredMirrorsRoot) {
    throw new Error(
      `Mirror path for repository ${repository.repositoryId} is outside the configured mirrors directory.`,
    );
  }
  const expectedFinalPath = path.join(
    mirrorsRoot,
    `${repository.repositoryId}.git`,
  );
  if (finalPath !== expectedFinalPath) {
    throw new Error(
      `Mirror path for repository ${repository.repositoryId} is outside its expected target.`,
    );
  }

  const temporaryPath = path.join(
    mirrorsRoot,
    `${repository.repositoryId}.git.tmp`,
  );
  if (
    path.dirname(temporaryPath) !== mirrorsRoot ||
    temporaryPath === finalPath
  ) {
    throw new Error("Refusing an unsafe temporary mirror path.");
  }
  return { mirrorsRoot, finalPath, temporaryPath };
}

async function measureMirrorSize(
  mirrorPath: string,
  signal?: AbortSignal,
): Promise<number> {
  let sizeBytes = 0;
  const pendingDirectories = [mirrorPath];

  while (pendingDirectories.length > 0) {
    if (signal?.aborted) {
      throw new Error("Git operation aborted.");
    }
    const directory = pendingDirectories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) {
        throw new Error("Git operation aborted.");
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      sizeBytes += (await lstat(entryPath)).size;
      if (!Number.isSafeInteger(sizeBytes)) {
        throw new Error("Mirror size exceeds the supported safe integer range.");
      }
    }
  }

  return sizeBytes;
}

/** Create or update a bare Git mirror without putting credentials in arguments. */
export async function syncMirror(
  repository: SyncJob,
  config: GitMirrorConfig,
  options: GitMirrorOptions = {},
): Promise<number> {
  const askPassPath =
    options.askPassPath ?? path.join(process.cwd(), "scripts", "git-askpass.sh");
  const resolvedMirrorPath = path.resolve(repository.mirrorPath);
  const sensitiveValues = [
    config.token,
    config.dataDir,
    path.resolve(config.dataDir),
    repository.mirrorPath,
    resolvedMirrorPath,
    `${resolvedMirrorPath}.tmp`,
  ];
  let finalPath: string | undefined;
  let temporaryPath: string | undefined;

  try {
    const lfsUrl = trustedLfsUrl(repository.cloneUrl);
    const paths = clonePaths(repository, config.dataDir);
    finalPath = paths.finalPath;
    temporaryPath = paths.temporaryPath;
    mkdirSync(paths.mirrorsRoot, { recursive: true });

    if (existsSync(finalPath)) {
      await runGit(
        ["-C", finalPath, "remote", "set-url", "origin", repository.cloneUrl],
        config,
        askPassPath,
        options.signal,
      );
      await runGit(
        ["-C", finalPath, "remote", "update", "--prune"],
        config,
        askPassPath,
        options.signal,
      );
    } else {
      rmSync(temporaryPath, { recursive: true, force: true });
      await runGit(
        ["clone", "--mirror", "--", repository.cloneUrl, temporaryPath],
        config,
        askPassPath,
        options.signal,
      );
      renameSync(temporaryPath, finalPath);
    }

    await runGit(
      [
        "-C",
        finalPath,
        "-c",
        `lfs.url=${lfsUrl}`,
        "lfs",
        "fetch",
        "--all",
        "origin",
      ],
      config,
      askPassPath,
      options.signal,
    );

    return await measureMirrorSize(finalPath, options.signal);
  } catch (error) {
    if (finalPath && temporaryPath && !existsSync(finalPath)) {
      rmSync(temporaryPath, { recursive: true, force: true });
    }
    throw new Error(sanitizeError(error, sensitiveValues));
  }
}
