import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { syncMirror } from "../lib/git-mirror";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;
const originalGitConfigCount = process.env.GIT_CONFIG_COUNT;
const originalGitConfigKey = process.env.GIT_CONFIG_KEY_0;
const originalGitConfigValue = process.env.GIT_CONFIG_VALUE_0;

const LFS_OBJECT_ID = "a".repeat(64);

async function installGitLfsFixture(): Promise<void> {
  const directory = await temporaryDirectory();
  const executable = path.join(directory, "git-lfs");
  await writeFile(
    executable,
    `#!/bin/sh
set -eu

test "$#" -eq 3
test "$1" = "fetch"
test "$2" = "--all"
test "$3" = "origin"

lfs_url="$(git config --get lfs.url)"
case "$lfs_url" in
  file://*|https://github.com/*.git/info/lfs) ;;
  *) echo "unexpected LFS URL" >&2; exit 2 ;;
esac

if [ -n "\${MIRRORMIRROR_LFS_LOG:-}" ]; then
  printf '%s\n' "$lfs_url" >> "$MIRRORMIRROR_LFS_LOG"
fi

if [ "\${MIRRORMIRROR_LFS_MODE:-success}" = "failure" ]; then
  printf 'LFS failed with %s at %s via https://x-access-token:%s@github.com/YumaIT/example.git\n' \
    "$GITHUB_TOKEN" "\${MIRRORMIRROR_LFS_ERROR_PATH:-unknown}" "$GITHUB_TOKEN" >&2
  exit 1
fi

if [ "\${MIRRORMIRROR_LFS_MODE:-success}" = "hang" ]; then
  : > "$MIRRORMIRROR_LFS_STARTED"
  while :; do sleep 1; done
fi

object_dir="$PWD/lfs/objects/aa/aa"
mkdir -p "$object_dir"
if [ ! -f "$object_dir/${LFS_OBJECT_ID}" ]; then
  printf 'fixture-lfs-payload' > "$object_dir/${LFS_OBJECT_ID}"
fi
`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
}

function restoreEnvironmentValue(
  name: string,
  originalValue: string | undefined,
): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mirror-git-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function createUpstream(root: string): Promise<string> {
  const upstream = path.join(root, "upstream");
  await mkdir(upstream);
  await git(["init", "--initial-branch=main"], upstream);
  await git(["config", "user.name", "Mirror Test"], upstream);
  await git(["config", "user.email", "mirror@example.com"], upstream);
  await writeFile(path.join(upstream, "README.md"), "first\n");
  await git(["add", "README.md"], upstream);
  await git(["commit", "-m", "first"], upstream);
  await git(["branch", "feature"], upstream);
  await git(["tag", "v1"], upstream);
  return upstream;
}

async function apparentSize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else {
        total += (await lstat(entryPath)).size;
      }
    }
  }
  return total;
}

beforeEach(async () => {
  await installGitLfsFixture();
});

afterEach(async () => {
  restoreEnvironmentValue("PATH", originalPath);
  restoreEnvironmentValue("GIT_CONFIG_COUNT", originalGitConfigCount);
  restoreEnvironmentValue("GIT_CONFIG_KEY_0", originalGitConfigKey);
  restoreEnvironmentValue("GIT_CONFIG_VALUE_0", originalGitConfigValue);
  delete process.env.MIRRORMIRROR_LFS_LOG;
  delete process.env.MIRRORMIRROR_LFS_MODE;
  delete process.env.MIRRORMIRROR_LFS_ERROR_PATH;
  delete process.env.MIRRORMIRROR_LFS_STARTED;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Git mirror integration", () => {
  it.each([
    "https://x-access-token:stolen@github.com/YumaIT/example.git",
    "https://example.com/YumaIT/example.git",
    "ssh://git@github.com/YumaIT/example.git",
  ])("rejects the unsafe clone URL %s before creating mirror state", async (cloneUrl) => {
    const root = await temporaryDirectory();

    await expect(
      syncMirror(
        {
          repositoryId: 40,
          fullName: "YumaIT/example",
          cloneUrl,
          mirrorPath: path.join(root, "mirrors", "40.git"),
        },
        { dataDir: root, token: "secret-token", gitOperationTimeoutMs: 10_000 },
      ),
    ).rejects.toThrow("unsafe repository clone URL");
    await expect(access(path.join(root, "mirrors"))).rejects.toThrow();
  });

  it("derives the trusted GitHub LFS endpoint before synchronization", async () => {
    const root = await temporaryDirectory();
    const upstream = await createUpstream(root);
    const cloneUrl = "https://github.com/YumaIT/example.git";
    const lfsLog = path.join(root, "lfs-urls.log");
    process.env.MIRRORMIRROR_LFS_LOG = lfsLog;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(upstream).href}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = cloneUrl;

    await syncMirror(
      {
        repositoryId: 41,
        fullName: "YumaIT/example",
        cloneUrl,
        mirrorPath: path.join(root, "mirrors", "41.git"),
      },
      { dataDir: root, token: "secret-token", gitOperationTimeoutMs: 10_000 },
    );

    expect((await readFile(lfsLog, "utf8")).trim()).toBe(
      `${cloneUrl}/info/lfs`,
    );
  });

  it("pins the local LFS endpoint and retains fetched payloads", async () => {
    const root = await temporaryDirectory();
    const upstream = await createUpstream(root);
    const mirrorPath = path.join(root, "mirrors", "42.git");
    const lfsLog = path.join(root, "lfs-urls.log");
    process.env.MIRRORMIRROR_LFS_LOG = lfsLog;
    const repository = {
      repositoryId: 42,
      fullName: "YumaIT/example",
      cloneUrl: upstream,
      mirrorPath,
    };
    const config = {
      dataDir: root,
      token: "secret-token",
      gitOperationTimeoutMs: 10_000,
    };

    const initialSize = await syncMirror(repository, config);
    const fixtureObject = path.join(
      mirrorPath,
      "lfs",
      "objects",
      "aa",
      "aa",
      LFS_OBJECT_ID,
    );
    expect(await readFile(fixtureObject, "utf8")).toBe("fixture-lfs-payload");
    expect(initialSize).toBe(await apparentSize(mirrorPath));
    expect((await readFile(lfsLog, "utf8")).trim()).toBe(
      pathToFileURL(upstream).href,
    );

    const retainedObject = path.join(
      mirrorPath,
      "lfs",
      "objects",
      "bb",
      "bb",
      "retained",
    );
    await mkdir(path.dirname(retainedObject), { recursive: true });
    await writeFile(retainedObject, "retain-me");

    const updatedSize = await syncMirror(repository, config);

    expect(await readFile(retainedObject, "utf8")).toBe("retain-me");
    expect(updatedSize).toBe(await apparentSize(mirrorPath));
  });

  it("preserves fetched payloads and redacts a failed LFS fetch", async () => {
    const root = await temporaryDirectory();
    const upstream = await createUpstream(root);
    const mirrorPath = path.join(root, "mirrors", "44.git");
    const repository = {
      repositoryId: 44,
      fullName: "YumaIT/failure",
      cloneUrl: upstream,
      mirrorPath,
    };
    const config = {
      dataDir: root,
      token: "secret-token",
      gitOperationTimeoutMs: 10_000,
    };
    await syncMirror(repository, config);
    const fixtureObject = path.join(
      mirrorPath,
      "lfs",
      "objects",
      "aa",
      "aa",
      LFS_OBJECT_ID,
    );
    process.env.MIRRORMIRROR_LFS_MODE = "failure";
    process.env.MIRRORMIRROR_LFS_ERROR_PATH = root;

    const message = await syncMirror(repository, config).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message).toContain("Git operation failed");
    expect(message).not.toContain(config.token);
    expect(message).not.toContain(root);
    expect(message).not.toContain("x-access-token:secret-token");
    expect(await readFile(fixtureObject, "utf8")).toBe("fixture-lfs-payload");
  });

  it("aborts an active LFS fetch without removing fetched payloads", async () => {
    const root = await temporaryDirectory();
    const upstream = await createUpstream(root);
    const mirrorPath = path.join(root, "mirrors", "45.git");
    const repository = {
      repositoryId: 45,
      fullName: "YumaIT/abort",
      cloneUrl: upstream,
      mirrorPath,
    };
    const config = {
      dataDir: root,
      token: "secret-token",
      gitOperationTimeoutMs: 10_000,
    };
    await syncMirror(repository, config);
    const fixtureObject = path.join(
      mirrorPath,
      "lfs",
      "objects",
      "aa",
      "aa",
      LFS_OBJECT_ID,
    );
    const startedPath = path.join(root, "lfs-started");
    process.env.MIRRORMIRROR_LFS_MODE = "hang";
    process.env.MIRRORMIRROR_LFS_STARTED = startedPath;
    const controller = new AbortController();

    const synchronization = syncMirror(repository, config, {
      signal: controller.signal,
    });
    await waitForPath(startedPath);
    controller.abort();

    await expect(synchronization).rejects.toThrow("Git operation aborted");
    expect(await readFile(fixtureObject, "utf8")).toBe("fixture-lfs-payload");
  });

  it("creates a bare mirror and updates every ref in place", async () => {
    const root = await temporaryDirectory();
    const upstream = await createUpstream(root);
    const mirrorPath = path.join(root, "mirrors", "42.git");
    const repository = {
      repositoryId: 42,
      fullName: "YumaIT/example",
      cloneUrl: upstream,
      mirrorPath,
    };
    const config = {
      dataDir: root,
      token: "secret-token",
      gitOperationTimeoutMs: 10_000,
    };

    const clonedSize = await syncMirror(repository, config);
    expect(clonedSize).toBe(await apparentSize(mirrorPath));
    expect(await git(["--git-dir", mirrorPath, "rev-parse", "--is-bare-repository"])).toBe(
      "true",
    );
    expect(await git(["--git-dir", mirrorPath, "rev-parse", "refs/heads/feature"])).toBeTruthy();
    expect(await git(["--git-dir", mirrorPath, "rev-parse", "refs/tags/v1"])).toBeTruthy();
    const inodeBefore = (await stat(mirrorPath)).ino;

    await writeFile(path.join(upstream, "README.md"), "second\n");
    await git(["add", "README.md"], upstream);
    await git(["commit", "-m", "second"], upstream);
    await git(["branch", "new-branch"], upstream);
    await git(["branch", "-D", "feature"], upstream);
    const outsideFile = path.join(root, "outside-mirror.bin");
    await writeFile(outsideFile, "x".repeat(20_000));
    await symlink(outsideFile, path.join(mirrorPath, "size-test-link"));
    const updatedSize = await syncMirror(repository, config);

    expect((await stat(mirrorPath)).ino).toBe(inodeBefore);
    expect(updatedSize).toBe(await apparentSize(mirrorPath));
    expect(updatedSize).toBeLessThan(clonedSize + 20_000);
    expect(await git(["--git-dir", mirrorPath, "rev-parse", "refs/heads/main"])).toBe(
      await git(["rev-parse", "refs/heads/main"], upstream),
    );
    expect(await git(["--git-dir", mirrorPath, "rev-parse", "refs/heads/new-branch"])).toBeTruthy();
    await expect(
      git(["--git-dir", mirrorPath, "rev-parse", "refs/heads/feature"]),
    ).rejects.toThrow();
    expect(await git(["--git-dir", mirrorPath, "remote", "get-url", "origin"])).toBe(
      upstream,
    );
  });

  it("preserves an established mirror when an update fails", async () => {
    const root = await temporaryDirectory();
    const upstream = await createUpstream(root);
    const mirrorPath = path.join(root, "mirrors", "7.git");
    const repository = {
      repositoryId: 7,
      fullName: "YumaIT/seven",
      cloneUrl: upstream,
      mirrorPath,
    };
    const config = {
      dataDir: root,
      token: "secret-token",
      gitOperationTimeoutMs: 10_000,
    };
    await syncMirror(repository, config);
    const originalCommit = await git([
      "--git-dir",
      mirrorPath,
      "rev-parse",
      "refs/heads/main",
    ]);
    const inodeBefore = (await stat(mirrorPath)).ino;
    await rename(upstream, path.join(root, "unavailable-upstream"));

    const message = await syncMirror(repository, config).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message).toContain("Git operation failed");
    expect(message).not.toContain(config.token);
    expect((await stat(mirrorPath)).ino).toBe(inodeBefore);
    await expect(
      git(["--git-dir", mirrorPath, "cat-file", "-e", originalCommit]),
    ).resolves.toBe("");
    expect(await git(["--git-dir", mirrorPath, "rev-parse", "--is-bare-repository"])).toBe(
      "true",
    );
  });

  it("does not report success when synchronization is aborted before measurement", async () => {
    const root = await temporaryDirectory();
    const upstream = await createUpstream(root);
    const mirrorPath = path.join(root, "mirrors", "15.git");
    const repository = {
      repositoryId: 15,
      fullName: "YumaIT/fifteen",
      cloneUrl: upstream,
      mirrorPath,
    };
    const config = {
      dataDir: root,
      token: "secret-token",
      gitOperationTimeoutMs: 10_000,
    };
    await syncMirror(repository, config);

    let abortedReads = 0;
    const signal = {
      get aborted(): boolean {
        abortedReads += 1;
        return abortedReads >= 3;
      },
      addEventListener(): void {},
      removeEventListener(): void {},
    } as unknown as AbortSignal;

    await expect(syncMirror(repository, config, { signal })).rejects.toThrow(
      "Git operation aborted",
    );
    expect(abortedReads).toBeGreaterThanOrEqual(3);
    expect(
      await git(["--git-dir", mirrorPath, "rev-parse", "--is-bare-repository"]),
    ).toBe("true");
  });

  it("cleans only the validated interrupted clone target", async () => {
    const root = await temporaryDirectory();
    const upstream = await createUpstream(root);
    const mirrorsRoot = path.join(root, "mirrors");
    const interruptedPath = path.join(mirrorsRoot, "42.git.tmp");
    const unrelatedMirror = path.join(mirrorsRoot, "99.git");
    await mkdir(interruptedPath, { recursive: true });
    await writeFile(path.join(interruptedPath, "partial"), "discard me");
    await mkdir(unrelatedMirror, { recursive: true });
    await writeFile(path.join(unrelatedMirror, "keep"), "untouched");

    await syncMirror(
      {
        repositoryId: 42,
        fullName: "YumaIT/example",
        cloneUrl: upstream,
        mirrorPath: path.join(mirrorsRoot, "42.git"),
      },
      { dataDir: root, token: "secret-token", gitOperationTimeoutMs: 10_000 },
    );

    expect(await readFile(path.join(unrelatedMirror, "keep"), "utf8")).toBe(
      "untouched",
    );
    await expect(access(interruptedPath)).rejects.toThrow();

    const missingFinal = path.join(mirrorsRoot, "43.git");
    const missingTemporary = path.join(mirrorsRoot, "43.git.tmp");
    const initialFailure = await syncMirror(
      {
        repositoryId: 43,
        fullName: "YumaIT/missing",
        cloneUrl: path.join(root, "does-not-exist"),
        mirrorPath: missingFinal,
      },
      { dataDir: root, token: "secret-token", gitOperationTimeoutMs: 10_000 },
    ).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(initialFailure).toContain("Git operation failed");
    expect(initialFailure).not.toContain(root);
    await expect(access(missingFinal)).rejects.toThrow();
    await expect(access(missingTemporary)).rejects.toThrow();
    expect(await readFile(path.join(unrelatedMirror, "keep"), "utf8")).toBe(
      "untouched",
    );
  });

  it("refuses cleanup outside the configured mirrors directory", async () => {
    const root = await temporaryDirectory();
    const unsafeMirror = path.join(root, "outside", "77.git");
    const unsafeTemporary = `${unsafeMirror}.tmp`;
    await mkdir(unsafeTemporary, { recursive: true });
    await writeFile(path.join(unsafeTemporary, "keep"), "protected");

    await expect(
      syncMirror(
        {
          repositoryId: 77,
          fullName: "YumaIT/unsafe",
          cloneUrl: path.join(root, "missing"),
          mirrorPath: unsafeMirror,
        },
        { dataDir: root, token: "secret-token", gitOperationTimeoutMs: 10_000 },
      ),
    ).rejects.toThrow("configured mirrors directory");
    expect(await readFile(path.join(unsafeTemporary, "keep"), "utf8")).toBe(
      "protected",
    );
  });
});
