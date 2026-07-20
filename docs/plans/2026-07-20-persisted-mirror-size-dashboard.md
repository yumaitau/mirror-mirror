# Persisted Mirror Size Dashboard Implementation Plan

Created: 2026-07-20
Author: josh@luongo.com.au
Agent: Codex
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Let operators see the last successfully measured size of every durable bare mirror in the dashboard without filesystem work in the web polling path.

## Out of Scope

- Creating checked-out working trees or changing the existing `git clone --mirror` storage format.
- Measuring allocated disk blocks, Git LFS objects, or live filesystem changes made outside a successful MirrorMirror synchronization.
- Scanning all existing mirrors at application startup; migrated repositories show **Not measured** until their next successful sync, which can be queued with **Sync now** or **Sync all**.
- Recording size history, organization totals, or storage quotas.

## Approach

**Chosen:** Return measured bytes from `syncMirror`, persist them with the successful `SyncOutcome`, and render the stored value from `getDashboardSnapshot`.
**Why:** This measures each bare repository exactly once after Git has successfully cloned or updated it and keeps the two-second dashboard polling path as a SQLite read. Existing databases gain a nullable column at the cost of showing an unknown size until each repository next synchronizes successfully.

## Runtime Environment

- Start the web app with `GITHUB_ORG=YumaIT GITHUB_TOKEN=test-token MIRROR_DATA_DIR=<temporary-data-directory> npm run dev`; Next.js serves the dashboard and `/api/health/web` on `http://localhost:3000` by default.
- Run `npm run build:worker && npm run worker` against the same environment only when exercising the real scheduler; controlled E2E fixtures may complete a queued repository through `openStore` so browser verification does not contact GitHub.
- Restart after code changes by stopping the background process and re-running the same command; poll `/api/health/web` until it returns HTTP 200 before browser automation.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The schema upgrade is interrupted or loses existing state. | Low | High | Apply the column and `user_version` change in one SQLite transaction, reject unsupported future versions, and verify a populated upgraded database reopens with all repository and schedule fields intact. |
| A large mirror-size traversal stalls worker heartbeats. | Medium | Medium | Use asynchronous Node filesystem APIs, check the abort signal while traversing, and never perform the traversal in the web/API process. |
| Git succeeds but size measurement fails or is aborted. | Low | Medium | Treat measurement as part of the sync attempt, retain the valid bare mirror and its previous persisted size, and record a sanitized failed attempt for retry. |

## E2E Test Scenarios

### TS-001: A forced sync replaces an unknown size with the persisted formatted size
**Priority:** Critical
**Preconditions:** The web app runs against a temporary version-2 store containing one healthy repository whose `sizeBytes` is null; no worker process is running.
**Mapped Tasks:** Task 1, Task 3

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Navigate to `http://localhost:3000` and snapshot the repository row. | The row shows **Mirror size — Not measured** and an enabled **Sync now** button. |
| 2 | Click **Sync now** and re-snapshot. | The row changes to **Queued**, the action is disabled, and the size remains **Not measured** while work is pending. |
| 3 | From the controlled fixture, claim the queued repository and complete it successfully with `sizeBytes: 1536`; wait for the dashboard poll and re-snapshot. | The row changes to **Healthy** and shows **Mirror size — 1.5 KiB**. |
| 4 | Reload the page and re-snapshot. | **1.5 KiB** remains visible, proving the dashboard loaded the persisted value. |

## Progress Tracking

- [x] Task 1: Persist mirror size in the durable store and dashboard contract
- [x] Task 2: Measure bare mirrors after successful Git synchronization
- [x] Task 3: Render persisted sizes in the dashboard and document the behavior

> Source of truth for completion. `spec-implement` toggles `[ ]` to `[x]` here.

## Implementation Tasks

### Task 1: Persist mirror size with successful synchronization state

**Objective:** Extend the durable repository state and shared contracts with an exact byte count that is written atomically with a successful scheduled or manual synchronization. Upgrade populated version-1 databases without touching mirror directories, and ensure dashboard reads use only SQLite.

**Files:**

- Modify: `lib/contracts.ts`
- Modify: `lib/store.ts`
- Test: `tests/backend.test.ts`
- Test: `tests/store-initialization.test.ts`

**Key Decisions / Notes:**

- Add nullable `sizeBytes` to `RepositorySummary` and require a non-negative safe integer on the successful `SyncOutcome`; a failed outcome remains error-only.
- Upgrade `PRAGMA user_version` from 1 to 2 with a nullable `mirror_size_bytes INTEGER` column constrained to null or a non-negative integer. Run the column addition and version advance in one SQLite transaction, create new databases directly at version 2, and reject databases newer than the supported schema instead of mutating them.
- Both `completeScheduledMember` and `completeSync` write `mirror_size_bytes`, `last_success_at`, healthy state, and cleared error in the same transaction. Failed, interrupted, and unavailable states retain the last successful size.
- `getDashboardSnapshot` selects the persisted column and maps it directly. Regression fixtures give a real mirror directory a byte size that differs from a stored sentinel, mutate that directory between repeated snapshots, and require the sentinel to remain unchanged so filesystem state cannot drive the polling result.
- Reject invalid success sizes before changing repository state so malformed values cannot partially complete work despite TypeScript types or the database constraint.

**Definition of Done:**

- [ ] Opening a populated version-1 database atomically migrates it to version 2, reopens successfully, and preserves repository state, queue work, success timestamps, and schedule data with a null size; opening an unsupported future version fails without mutation.
- [ ] Manual and scheduled successful completions persist and expose an exact `sizeBytes`; failures and interrupted work preserve the prior successful value.
- [ ] Repeated snapshots return a persisted sentinel size even when a real mirror directory has a different size and changes between polls, demonstrating that filesystem state does not supply dashboard values.
- [ ] Verify: `npm test -- --reporter=dot tests/backend.test.ts`

### Task 2: Measure the bare mirror after Git finishes

**Objective:** Make `syncMirror` return the apparent byte size of the retained bare repository after either clone or in-place update, then carry that value through the worker's successful completion. Keep traversal asynchronous, abort-aware, and confined to the worker sync path.

**Files:**

- Modify: `lib/git-mirror.ts`
- Modify: `worker/scheduler.ts`
- Test: `tests/git-mirror.integration.test.ts`
- Test: `tests/worker.test.ts`

**Key Decisions / Notes:**

- Continue using `git clone --mirror` and `remote update --prune`; measure `finalPath` only after the clone has been atomically renamed or the update command has completed.
- Define the portable displayed metric as apparent bytes: recursively sum non-directory entry sizes with asynchronous `lstat`, never follow symbolic links, and reject totals above `Number.MAX_SAFE_INTEGER`.
- Check the existing `AbortSignal` between traversal operations. If traversal fails or aborts after Git changed the mirror, leave the bare repository in place, do not overwrite a prior size, and let the scheduler record/recover the attempt through its existing error path.
- Change the worker mirror dependency to `Promise<number>` and create `{ success: true, sizeBytes }` only after `syncMirror` returns; update every existing mirror mock so tests cannot accidentally execute real Git or filesystem work.

**Definition of Done:**

- [ ] A real local bare clone and a subsequent in-place update each return a non-negative safe byte count matching an independent test-side walk of the final mirror directory.
- [ ] Size traversal does not follow a symlink placed inside a test mirror, and an aborted traversal does not report a successful outcome.
- [ ] Manual and scheduled worker paths persist the returned byte count, while a mirror or measurement failure preserves the last successful size and sanitized error behavior.
- [ ] Verify: `npm test -- --reporter=dot tests/git-mirror.integration.test.ts tests/worker.test.ts`

### Task 3: Display the persisted mirror size

**Objective:** Add a compact mirror-size field to each responsive dashboard row, format exact persisted bytes with deterministic IEC units, and expose the raw byte count through the existing status API. Document that the value is refreshed only after a successful synchronization and may initially be unknown after migration; verify the force-sync user flow with TS-001.

**Files:**

- Modify: `app/mirror-dashboard.tsx`
- Modify: `app/globals.css`
- Test: `tests/api.test.ts`
- Modify: `README.md`

**Key Decisions / Notes:**

- Render `0 B` exactly and otherwise use deterministic `B`, `KiB`, `MiB`, `GiB`, `TiB`, or `PiB` formatting with at most one decimal; render null as **Not measured**.
- Place the size alongside the existing attempt/success definition list and preserve the current memoized row and repository-array reuse so two-second polling does not add expensive render work.
- Keep `/api/status` response structure unchanged except for nullable `sizeBytes`; API tests assert that repeated requests return raw persisted bytes even when the corresponding mirror directory has a different size and changes between requests, leaving presentation formatting solely in the client component.
- Update the README data/synchronization and status sections to distinguish bare-repository apparent bytes from live disk allocation and explain the post-migration null state.

**Definition of Done:**

- [ ] `/api/status` returns the exact persisted byte count or null for each repository without exposing credentials or host paths.
- [ ] The responsive dashboard shows deterministic IEC text for measured repositories and **Not measured** for null values without clipping the repository action or timestamps.
- [ ] Clicking **Sync now** and completing the queued fixture updates the displayed size on a subsequent poll, and reloading preserves it, as specified by TS-001.
- [ ] README instructions accurately describe when and how mirror size is measured and persisted.
- [ ] Verify: `npm test -- --reporter=dot tests/api.test.ts && npm run typecheck && npm run lint && npm run build`

## E2E Results

| Scenario | Priority | Result | Fix Attempts | Notes |
| --- | --- | --- | --- | --- |
| TS-001 | Critical | PASS | 0 | Playwright verified Not measured, click-to-queue, persisted 1.5 KiB after polling, and 1.5 KiB after reload. |

Design Notes: `impeccable detect` returned no advisory findings for the changed dashboard TSX and CSS.
