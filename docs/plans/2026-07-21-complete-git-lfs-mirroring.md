# Complete Git LFS Mirroring Implementation Plan

Created: 2026-07-21
Author: josh@luongo.com.au
Agent: Codex
Status: COMPLETE
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Make every successful MirrorMirror synchronization retain all Git LFS payloads referenced by every mirrored ref, report Git-or-LFS failures through the existing repository state, and ship the required tooling in the supported Docker image without exposing the GitHub token to repository-controlled LFS endpoints.

## Out of Scope

- Separate LFS status, byte counts, progress, controls, repository filters, or configuration in the dashboard.
- Automatic LFS pruning, garbage collection, quotas, retention windows, cross-repository deduplication, or deletion of previously fetched payloads.
- Automated checkout, restore, LFS serving, or push-back workflows.
- Transactional rollback of refs already accepted by an in-place Git update when the following LFS fetch fails; the attempt remains failed until a complete retry succeeds.
- A new LFS-specific timeout or cancellation control; LFS uses the existing per-command Git operation timeout and worker shutdown signal.
- Git LFS endpoints outside the token-free GitHub repository endpoint derived from the validated clone URL; repository-controlled endpoint overrides fail closed.

## Approach

**Chosen:** Extend `syncMirror` in `lib/git-mirror.ts` with a command-scoped, trusted `lfs.url` and `git lfs fetch --all origin`, then package Debian's `git-lfs` binary and exercise the compiled application against a real disposable local LFS remote.
**Why:** Git LFS documents `fetch --all` specifically for backup and migration and makes it cover all refs when none are named, while a command-scoped endpoint prevents a committed `.lfsconfig` from redirecting the organization token. This adds one potentially long and storage-heavy command to every repository sync plus a production-like container test, in exchange for one truthful combined health result and evidence from the real Git LFS binary rather than a mock alone.

## Context for Implementer

The authoritative [`git lfs fetch --all`](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-fetch.adoc) contract downloads objects reachable from every ref when no refs are passed, ignores configured include/exclude filters, skips already-present objects unless `--refetch` is supplied, and prunes only when `--prune` is supplied. `lib/github-client.ts` already rejects clone URLs that are not credential-free `https://github.com` URLs before they reach persistence; `syncMirror` must derive `https://github.com/{owner}/{repository}.git/info/lfs` from that validated URL and supply it through Git's command-scoped `-c lfs.url=...` before credentials are available. Existing local-path integration fixtures may normalize their clone path to an equivalent `file://` LFS URL, but production HTTP(S) endpoints other than GitHub must fail closed. The `node:24.18.0-bookworm-slim` runtime can install Debian's [`git-lfs` package](https://packages.debian.org/bookworm/git-lfs); no npm dependency or custom LFS protocol client is needed.

## Runtime Environment

- **Production-like stack:** `docker compose up --build --detach`; the dashboard is served at `http://127.0.0.1:${MIRRORMIRROR_PORT:-3000}`, and `docker compose ps` reports independent web and worker health.
- **Focused tests:** `npm test -- --reporter=dot tests/git-mirror.integration.test.ts tests/worker.test.ts`; the integration test creates a temporary `git-lfs` executable on `PATH` for deterministic failure, abort, redaction, and command-contract cases because the host currently has Git but not Git LFS.
- **Real LFS test:** `npm run test:git-lfs-container` builds/uses `mirror-mirror:local`, creates a disposable multi-ref file-backed LFS remote inside the container, invokes the compiled `syncMirror`, and checks actual object OIDs, endpoint pinning, size inclusion, reuse, and retention.
- **Controlled browser verification:** start `npm run dev` against a temporary SQLite store with no real worker, use the store fixture to complete browser-queued work, and poll `/api/health/web` before executing TS-001.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `--all` substantially increases synchronization time and retained storage for large histories. | Medium | High | Keep serial scheduling and the existing per-command timeout, never report partial success, omit `--refetch`, and document that retained LFS storage can grow without automatic reclamation. |
| A committed `.lfsconfig` redirects LFS authentication and the GitHub token to an attacker-controlled endpoint. | Medium | Critical | Validate/derive a token-free endpoint before the first subprocess, override repository configuration with command-scoped `lfs.url`, fail closed for non-GitHub production URLs, and prove a malicious `.lfsconfig` cannot reach a capture server in the real container test. |
| LFS stderr exposes the GitHub token, authenticated URL, or host mirror path. | Low | High | Reuse the existing askpass-only environment and `sanitizeError` boundary, then make the focused failing-LFS fixture emit each sensitive form and assert none survive. |
| A Git-only update is incorrectly reported healthy when Git LFS is missing, aborted, or fails. | Medium | High | Place LFS fetch before size measurement/return, test failure and abort behavior, and rely on the existing worker rejection path that preserves prior success metadata and continues the cycle. |
| A fake executable passes while the packaged Git LFS binary fails on bare mirrors or all-ref discovery. | Medium | High | Keep the fake only for deterministic error paths and require a built-image test that transfers distinct real payloads reachable only from separate refs through compiled `syncMirror`. |

## E2E Test Scenarios

### TS-001: An LFS failure preserves prior health data and a retry recovers
**Priority:** Critical
**Preconditions:** The web app runs against a temporary store containing one healthy repository with a prior success timestamp and `sizeBytes: 1536`; no real worker is running, and a controlled store fixture can claim and complete queued work.
**Mapped Tasks:** Task 1

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Navigate to `http://127.0.0.1:3000` and snapshot the repository row. | The row is **Healthy**, shows **Mirror size — 1.5 KiB**, retains its prior success timestamp, and offers **Sync now**. |
| 2 | Click **Sync now** and re-snapshot. | The row changes to **Queued**, the action is disabled, and the prior size and success timestamp remain visible. |
| 3 | From the controlled fixture, claim the job and complete it with the sanitized failure `Git LFS download failed`; wait for dashboard polling and re-snapshot. | The row changes to **Failed**, shows the LFS failure, and still shows **1.5 KiB** and the prior success timestamp. |
| 4 | Click **Sync now** again, then have the fixture claim and successfully complete the retry with `sizeBytes: 4096`; wait and re-snapshot. | The row changes to **Healthy**, the error clears, and **Mirror size — 4 KiB** appears with the new success timestamp. |
| 5 | Reload the page and re-snapshot. | The recovered healthy state and **4 KiB** remain visible from persisted state. |

## Progress Tracking

- [x] Task 1: Pin the trusted LFS endpoint and fetch every referenced payload inside `syncMirror`
- [x] Task 2: Package and exercise real Git LFS, then document the combined mirror contract

> Source of truth for completion. `spec-implement` toggles `[ ]` to `[x]` here.

## Implementation Tasks

### Task 1: Pin the trusted endpoint and fetch every referenced LFS payload

**Objective:** Extend the existing `syncMirror` boundary so it derives a safe LFS endpoint before any credential-bearing subprocess and returns a measured size only after Git refs and all reachable LFS payloads are present. Use the existing rejection path for unsafe endpoints, missing tooling, authentication, timeout, abort, and transfer errors so the scheduler records one combined outcome and the dashboard behavior is verified by TS-001.

**Files:**

- Modify: `lib/git-mirror.ts`
- Test: `tests/git-mirror.integration.test.ts`

**Key Decisions / Notes:**

- Write the failing focused behavior first by prepending a temporary executable `git-lfs` fixture to `PATH`; keep real local Git for clone/ref behavior while mocking only the unavailable LFS transfer boundary.
- Before the first subprocess, derive the LFS URL from `repository.cloneUrl`: credential-free `https://github.com/{owner}/{repository}.git` maps to the same URL with `/info/lfs`, local filesystem fixtures normalize to `file://`, and every other protocol/HTTP host rejects without invoking Git or askpass. Preserve the existing `lib/github-client.ts` GitHub URL validation as the production entry-point guard rather than adding a second provider/config path.
- After a new clone is renamed to `finalPath`, or after `remote update --prune` completes in place, invoke `git -C finalPath -c lfs.url=trustedLfsUrl lfs fetch --all origin` through the existing `runGit` helper before measuring. Command-scoped Git configuration must override `.lfsconfig` and keep `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT=0`, `GITHUB_TOKEN`, stderr bounding, timeout, and abort behavior identical to clone/update.
- Do not add `--prune`, `--refetch`, include/exclude filters, repository toggles, a new public abstraction, or a new worker result type. The existing `Promise<number>` boundary already makes scheduler success contingent on the full method returning.
- Extend the existing integration test class rather than adding a test file per LFS case. The fixture accepts only the pinned `fetch --all origin` contract, deposits deterministic bytes beneath the bare mirror's `lfs/objects`, supports sanitized failure/abort modes, rejects unsafe HTTP endpoints before execution, and leaves a seeded unreferenced payload untouched across a later sync.
- Reuse existing `tests/worker.test.ts` coverage for repository failure isolation, prior-size retention, retry queuing, and shutdown recovery; the focused verification command runs it to prove the unchanged caller contract.

**Definition of Done:**

- [x] A valid GitHub clone URL produces the token-free GitHub LFS endpoint, while a credential-bearing URL, non-GitHub HTTP(S) host, or unsupported scheme fails before Git/LFS/askpass execution; existing local-path integration fixtures remain supported without a production endpoint setting.
- [x] An initial bare clone and a later in-place update invoke the pinned LFS backup contract before returning; deterministic fixture payloads are present beneath the final mirror and included in the independently measured returned byte count.
- [x] A repository with no LFS pointer payloads still completes through the same path without special configuration, and an already-present LFS object is not forcibly downloaded again.
- [x] A previously fetched LFS object remains after an upstream ref is removed and another synchronization completes; no prune or garbage-collection command runs.
- [x] A failing or aborted LFS fetch rejects `syncMirror`, leaves the bare mirror and prior payloads in place, and exposes neither the token, a credential-bearing URL, nor the configured host path in its bounded error.
- [x] The existing worker failure path treats the rejection as a failed repository attempt, preserves prior successful size/timestamp data, continues other cycle members, and can retry through the same queue.
- [x] Verify: `npm test -- --reporter=dot tests/git-mirror.integration.test.ts tests/worker.test.ts`

### Task 2: Package and exercise real Git LFS, then document the contract

**Objective:** Make the supported Docker image contain working Git LFS tooling and add one production-like functional test that runs compiled `syncMirror` with the real binary against a disposable multi-ref LFS remote. Update operator documentation to describe complete LFS coverage, endpoint safety, preservation, size accounting, failure semantics, and local-development prerequisites without adding application configuration or dashboard controls.

**Files:**

- Modify: `Dockerfile`
- Modify: `package.json`
- Create: `tests/git-lfs-container.sh`
- Modify: `README.md`

**Key Decisions / Notes:**

- Write `tests/git-lfs-container.sh` first and confirm RED against the current image because `git lfs version` is unavailable, then install the Debian Bookworm `git-lfs` package beside `git` and `ca-certificates` in the existing runtime layer. Do not add an npm dependency, external package repository, downloaded release binary, or global `git lfs install` hook mutation.
- The shell test runs as the unprivileged `node` user in the built image, creates a file-backed bare upstream, and uses real Git LFS to publish distinct deterministic payloads reachable only from main, a secondary branch, and a tag. It then calls `dist-worker/lib/git-mirror.js` rather than duplicating the production command.
- Commit a malicious `.lfsconfig` that points to a local HTTP capture server while publishing through a command-scoped trusted file URL. `syncMirror` must fetch every expected OID from the file remote and the capture server must record zero requests, proving repository configuration cannot redirect the PAT.
- After the initial mirror, remove one upstream LFS object that already exists locally, add and publish a new payload, and synchronize again. Success proves present objects are not refetched; deleting its upstream ref and synchronizing once more must leave the local object in place.
- Compare every expected SHA-256 OID with the standard `lfs/objects/{first-two}/{next-two}/{oid}` path in the managed bare mirror, and independently walk the mirror to confirm `syncMirror` includes those bytes in its returned size.
- Add `test:git-lfs-container` to `package.json`; keep this functional class alongside the existing focused `tests/git-mirror.integration.test.ts` class rather than splitting scenarios into more files.
- Update Requirements and Local development so Docker users need no host installation while developers running the worker directly need Git LFS on `PATH`. Replace the current README limitation with all-ref coverage, pinned GitHub endpoints, combined status, retained storage growth, size inclusion, no pruning, and no automated restore/LFS-serving promise.

**Definition of Done:**

- [x] A freshly built `mirror-mirror:local` image runs `git lfs version` successfully as UID/GID 1000, while the existing Docker permission/symlink checks still pass.
- [x] Compiled `syncMirror` downloads the exact real LFS OIDs reachable only from main, a secondary branch, and a tag into the managed bare mirror and returns an independently confirmed total size that includes their payload bytes.
- [x] A malicious committed `.lfsconfig` causes no request to the capture server, and the test never places the PAT in an endpoint, process argument, recorded request, or diagnostic output.
- [x] A later real sync fetches a new object without requiring an already-local object to remain upstream; deleting a ref and syncing again preserves its previously fetched LFS object.
- [x] The documented Docker Compose workflow requires no manual Git LFS installation, the direct local-worker workflow names Git LFS as a prerequisite, and README behavior/limitations match the complete-retained mirror contract.
- [x] Verify: `docker compose build && npm run test:git-lfs-container && npm run test:docker-permissions`

## E2E Results

| Scenario | Priority | Result | Fix Attempts | Notes |
|----------|----------|--------|--------------|-------|
| TS-001 | Critical | PASS | 0 | Playwright CLI verified the isolated production dashboard through healthy, queued, failed, retry, recovered, and persisted states. |

Live-target probe: Tier 1 found an existing server on port 3000, but it was not used because TS-001 requires a controlled disposable store. Tier 2 started the built production server on port 3001 with an isolated SQLite fixture and passed; Tier 3 was not needed.

Design Notes: skipped because no UI files or rendered UI output changed in this implementation.

## Verification Findings

- Fixed: the independent changes review found that the real-container heredoc needed Docker stdin attached; `--interactive` now ensures all three real Git LFS synchronization cycles and their assertions execute.
