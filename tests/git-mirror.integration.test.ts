import { execFile } from "node:child_process";
import {
  access,
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
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { syncMirror } from "../lib/git-mirror";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Git mirror integration", () => {
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
