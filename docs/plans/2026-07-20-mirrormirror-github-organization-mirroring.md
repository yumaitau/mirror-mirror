# MirrorMirror GitHub Organization Mirroring Implementation Plan

Created: 2026-07-20
Author: josh@luongo.com.au
Agent: Codex
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Let an operator run MirrorMirror with Docker Compose, maintain durable bare mirrors for every repository accessible in one GitHub organization, inspect synchronization health, and queue early per-repository or organization-wide synchronization from a web dashboard.

## Out of Scope

- Git LFS payloads, checked-out working trees, recursive submodule mirroring, and GitHub metadata outside Git objects and refs.
- GitHub Enterprise Server, multiple organizations, GitHub App/OAuth/SSH authentication, dashboard accounts, or role-based access.
- Webhooks, per-repository schedules, exclusion filters, historical snapshots, automatic deletion, restore/push-back operations, and user-initiated cancellation of an active Git process.
- Multiple worker replicas or storage on NFS/SMB-style network filesystems; this version coordinates one web service and one worker through one host-local data directory.

## Approach

**Chosen:** Next.js App Router dashboard and Route Handlers over a shared SQLite state store, with a dedicated TypeScript worker for GitHub discovery, scheduling, and Git mirror operations.
**Why:** This keeps Git work outside `app/page.tsx` and the web request lifecycle while giving both Compose services durable, transactional queue state without another infrastructure service. It costs a Node.js 24 runtime requirement and deliberately limits synchronization to one repository at a time.

## Context for Implementer

GitHub's stable numeric repository ID is the internal identity. Human-readable names and clone URLs may change; host storage does not: each mirror lives at `mirrors/{github-id}.git` beneath the configured data directory. A discovery response is reconciled only after every API page succeeds, so an authentication, rate-limit, or pagination failure can never mark the whole organization unavailable. Git credentials are provided to Git through `GIT_ASKPASS`; the token must never appear in process arguments, stored remote URLs, API responses, persisted errors, or logs.

The implementation follows the bundled Next.js 16 guides at `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`, and `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md`. GitHub requests follow the current [organization repository endpoint](https://docs.github.com/en/rest/repos/repos#list-organization-repositories) and [token authentication guidance](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api). Persistence uses Node 24's built-in [`node:sqlite`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) rather than a native npm database dependency.

## Runtime Environment

- **Local web:** `npm run dev` on `http://127.0.0.1:3000`; restart the command after server-module changes.
- **Local worker:** `npm run build:worker && npm run worker`; `npm run worker -- --healthcheck` verifies the persisted heartbeat.
- **Production:** `docker compose up --build -d`; the dashboard is on `${MIRRORMIRROR_PORT:-3000}` and both services mount `${MIRROR_HOST_PATH:-./mirror-data}` at `/data`.
- **Health:** `GET /api/health/web` proves the web process is serving; `GET /api/health/worker` and the worker `--healthcheck` command return unhealthy when the heartbeat is stale.
- **Restart:** `docker compose restart web worker`; queued work and an interrupted `syncing` record recover from the SQLite state on worker startup.

## File Structure

- `package.json` (modify) — Node requirement, Vitest scripts, worker build/start scripts, and quality commands.
- `package-lock.json` (modify) — locked Vitest and Node type dependency versions.
- `lib/contracts.ts` (create) — serializable repository, scheduler, worker-health, and API response contracts.
- `lib/config.ts` (create) — validated runtime configuration with 60-minute schedule and Git timeout defaults.
- `lib/errors.ts` (create) — bounded error normalization and secret/credential redaction.
- `lib/store.ts` (create) — SQLite schema, discovery reconciliation, manual queue claims, fixed scheduled-cycle membership, state transitions, scheduler state, and heartbeat queries.
- `lib/github-client.ts` (create) — authenticated, paginated organization repository discovery with response validation.
- `lib/git-mirror.ts` (create) — safe bare-clone and remote-update orchestration using argument-array subprocess calls.
- `scripts/git-askpass.sh` (create) — non-interactive Git HTTPS credential provider that reads the token from the process environment.
- `worker/scheduler.ts` (create) — startup recovery, discovery, recurring cycles, manual-queue draining, and graceful shutdown.
- `worker/index.ts` (create) — worker entry point and heartbeat healthcheck mode.
- `tsconfig.worker.json` (create) — CommonJS worker compilation into `dist-worker/` for direct Node execution.
- `app/api/status/route.ts` (create) — uncached dashboard snapshot endpoint.
- `app/api/sync/route.ts` (create) — global queue endpoint.
- `app/api/repositories/[repositoryId]/sync/route.ts` (create) — per-repository queue endpoint.
- `app/api/health/[component]/route.ts` (create) — web/worker health endpoint using Next.js 16 async route params.
- `app/page.tsx` (modify) — dynamically rendered dashboard page with an initial persisted snapshot.
- `app/mirror-dashboard.tsx` (create) — interactive polling, manual actions, action feedback, and responsive repository ledger.
- `app/layout.tsx` (modify) — MirrorMirror metadata and IBM Plex font setup.
- `app/globals.css` (modify) — Tailwind theme tokens and global industrial-console foundation.
- `tests/backend.test.ts` (create) — parsimonious unit coverage for configuration, errors, store, and GitHub discovery.
- `tests/git-mirror.integration.test.ts` (create) — real local-Git behavioral coverage for clone, update, pruning, and failure preservation.
- `tests/worker.test.ts` (create) — scheduler/recovery tests with GitHub and Git subprocess boundaries mocked.
- `tests/api.test.ts` (create) — direct Route Handler behavior for success, deduplication, invalid IDs, unknown repositories, and health.
- `next.config.ts` (modify) — standalone production output.
- `Dockerfile` (create) — pinned multi-stage Node 24 image shared by web and worker.
- `.dockerignore` (create) — bounded Docker context excluding dependencies, build output, local mirrors, and tool state.
- `compose.yaml` (create) — web/worker services, shared bind mount, health checks, and non-privileged runtime.
- `.env.example` (create) — documented deployment configuration without credentials.
- `.gitignore` (modify) — keep `.env.example`, worker output, and local mirror data handled correctly.
- `README.md` (modify) — setup, PAT permissions, storage layout, operations, health, troubleshooting, and MVP limitations.

## Assumptions

- The host mirror path is on a local filesystem that supports SQLite locking and atomic directory rename semantics — Tasks 2, 4, 5, 8, and 9 depend on this.
- One worker service is the only Git executor; SQLite still claims jobs transactionally so duplicate web requests and accidental overlapping claims cannot run the same repository twice — Tasks 2, 5, and 9 depend on this.

## Autonomous Decisions

- Pin the production image to `node:24.18.0-bookworm-slim`; Node 24.15 or newer is required because `node:sqlite` reached release-candidate stability there.
- Store state in `${MIRROR_DATA_DIR}/mirrormirror.db` and mirrors in `${MIRROR_DATA_DIR}/mirrors/{github-id}.git`; Compose sets `MIRROR_DATA_DIR=/data`.
- Synchronize repositories serially. Add the required `SHORTCUT:` marker naming full-cycle duration exceeding the configured interval as the trigger for bounded parallelism.
- Poll durable manual work every 1 second, write a heartbeat every 5 seconds, consider it stale after 30 seconds, and abort one Git operation after `GIT_OPERATION_TIMEOUT_MINUTES` (default 60).
- Send `X-GitHub-Api-Version: 2026-03-10`, use `per_page=100&type=all`, and follow the API `Link` header until no next page remains.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A PAT appears in a Git command, remote, error, or response | Low | High | Use token-free HTTPS clone URLs plus `GIT_ASKPASS`, redact configured secrets and credential-bearing URLs at every error boundary, and assert persisted/API-visible errors contain neither value. |
| Web and worker contend on SQLite or manual work changes schedule timing | Medium | High | Enable WAL and a busy timeout, use parameterized statements and `BEGIN IMMEDIATE` transactions, persist a fixed member list for each scheduled cycle, recover stale `syncing` rows on startup, and exercise two store connections in tests. |
| Initial clone failure or interruption destroys the last usable mirror | Low | High | Clone into an ID-scoped temporary sibling, atomically rename only after success, validate cleanup targets remain beneath the mirror root, and never delete an established mirror during update failure. |
| A host bind mount is not writable by the non-root container user | Medium | Medium | Fail startup with the resolved data path and a permission-specific message, document UID 1000 ownership preparation, and include a Compose smoke run against a fresh host directory. |
| A discovery failure marks valid repositories unavailable | Low | High | Accumulate and validate every API page in memory, reconcile in one transaction only after complete success, and test auth/rate-limit/page failures against existing state. |

## Goal Verification

### Truths

1. With a reachable GitHub repository and valid read credentials, one worker cycle progresses from discovery through a valid host bare mirror to a persisted healthy state that the dashboard reports without exposing the credential.
2. Recreating the web and worker containers against the same host directory preserves repository files, prior success timestamps, queued work, and the schedule; existing mirrors update in place instead of being cloned from scratch.

## E2E Test Scenarios

### TS-001: Inspect mirror health and queue one repository
**Priority:** Critical
**Preconditions:** The live app uses a temporary data directory seeded through the compiled `lib/store.ts` API with one healthy repository, one previously successful repository whose latest attempt failed, and one unavailable repository; the worker heartbeat is current.
**Mapped Tasks:** Task 2, Task 6, Task 7

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/` and capture an interactive snapshot. | The page has one `h1`, identifies the configured organization, shows all three repositories, distinguishes healthy/failed/unavailable states, and exposes exact timestamps without horizontal overflow. |
| 2 | Click **Sync now** for the healthy repository. | The action reports that work was accepted and the button becomes disabled while the repository is queued. |
| 3 | Capture a new snapshot after the next status refresh. | The repository reads **Queued**, its earlier successful timestamp remains visible, and no second active request can be submitted. |
| 4 | Allow the controlled worker fixture to claim the queued row, then capture another snapshot. | The repository reads **Synchronizing** and still shows its prior successful timestamp. |
| 5 | Allow the controlled worker fixture to finish successfully, then capture a final snapshot. | The repository reads **Healthy**, the successful timestamp advances, the stale error is cleared, and **Sync now** is enabled again. |

### TS-002: Queue all accessible repositories without duplicating work
**Priority:** Critical
**Preconditions:** The live app has two available repositories (one already queued) and one unavailable repository.
**Mapped Tasks:** Task 2, Task 6, Task 7

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/`, capture a snapshot, and click **Sync all**. | An accessible status message reports accepted versus already-active counts. |
| 2 | Capture a new snapshot after refresh. | Both available repositories are queued exactly once, the unavailable repository remains unavailable, and its row is not changed by the global action. |

### TS-003: Retry while the worker is offline
**Priority:** High
**Preconditions:** The live app has a failed repository with an earlier successful timestamp and a heartbeat older than 30 seconds; a controlled worker fixture can claim the durable request and complete it with a sanitized failure after the queued snapshot is captured.
**Mapped Tasks:** Task 5, Task 6, Task 7

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/` and capture a snapshot. | A worker-offline warning is visible; the failed row shows its latest sanitized error and earlier successful timestamp. |
| 2 | Click **Sync now** on the failed repository. | The durable request is accepted even though execution cannot begin, and the UI explains that it is queued. |
| 3 | Capture a new snapshot. | The row is queued, the worker warning remains, and no secret-like credential text appears in the page. |
| 4 | Let the controlled fixture claim and fail the request, then capture a final snapshot. | The row returns to **Failed**, retains the earlier successful timestamp, shows the new sanitized error, and exposes no credential text. |

### TS-004: Operate the dashboard at a mobile viewport
**Priority:** Medium
**Preconditions:** The live app has at least two repositories and a current worker heartbeat; browser emulation is set to a 390 by 844 CSS-pixel viewport.
**Mapped Tasks:** Task 7

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/` and capture a snapshot. | Repository information reflows into a readable ledger without clipped headings, off-screen actions, or horizontal page scrolling. |
| 2 | Click one visible **Sync now** button. | The control remains at least 44 CSS pixels high, receives visible focus, and reports the queued state in the next snapshot. |

## Verification Results

### Automated and runtime checks

| Check | Result | Evidence |
|------|--------|----------|
| Full test suite | PASS | 4 files and 50 tests passed with Vitest. |
| TypeScript, lint, and production build | PASS | `tsc --noEmit`, ESLint, the Next.js production build, and the compiled worker build completed successfully. |
| Changes review | PASS | One must-fix and two should-fix findings were corrected: host-path redaction, persistence-completion isolation, and future-heartbeat rejection. Focused regression coverage passed afterward. |
| Container image | PASS | The current image contains Node 24.18.0 and Git 2.39.5 and runs as UID/GID 1000. |
| Docker Compose recreation | PASS | Both services became healthy; force-recreating both containers against the same host directory preserved the exact next schedule, and the configured credential was absent from API output and Compose logs. |
| Live-target probe | PASS | No prior server was listening on port 3000; the documented production start command then served a healthy live target from a fresh durable directory. |
| Design-quality detector | PASS | `impeccable detect` returned an empty findings array for the changed UI files. |

### Structured E2E results

Browser: `playwright-cli` with isolated session `mirrormirror-spec-20260720`.

| Scenario | Result | Evidence |
|----------|--------|----------|
| TS-001 | PASS | The live dashboard rendered healthy, failed, and unavailable repositories; clicking **Sync now** produced `queued -> synchronizing -> healthy`, retained the prior success while active, advanced it on success, and re-enabled the action. |
| TS-002 | PASS | **Sync all** reported one accepted and one already active; both available rows were queued exactly once while the unavailable row remained unchanged. |
| TS-003 | PASS | A stale heartbeat produced the offline warning; retrying remained durable, preserved the prior success, returned to failed after the controlled attempt, and rendered the injected token and host path only as `[REDACTED]`. |
| TS-004 | PASS | At 390 by 844 CSS pixels the page had no horizontal overflow, all actions were 46.78 pixels high, keyboard focus rendered a 3-pixel outline, and clicking **Sync now** produced the queued state. |

### Not verified against external production data

- A live GitHub organization discovery and clone with a real PAT was not run because no credential was supplied for verification. The GitHub boundary is covered with paginated HTTP tests, and the Git boundary is covered by real local repositories that verify bare clone, every-ref updates, pruning, update-in-place behavior, and failure preservation.

## Progress Tracking

- [x] Task 1: Establish validated configuration, redaction, and the test harness.
- [x] Task 2: Implement durable repository, queue, schedule, and heartbeat state.
- [x] Task 3: Discover and validate all accessible organization repositories.
- [x] Task 4: Create and update safe bare Git mirrors.
- [x] Task 5: Run recovery, scheduled cycles, and manual work in the worker.
- [x] Task 6: Expose dashboard, sync, and health Route Handlers.
- [x] Task 7: Build the responsive operational dashboard.
- [x] Task 8: Produce the shared production container image.
- [x] Task 9: Wire Docker Compose and operator documentation.

> Source of truth for completion. `spec-implement` toggles `[ ]` to `[x]` after each task passes its Definition of Done.

## Implementation Tasks

### Task 1: Establish runtime configuration and safe errors

**Objective:** Add the minimal Vitest harness, require the Node version used in production, and implement one validated configuration boundary shared by web and worker processes. Centralize bounded error normalization so secrets cannot leak through later GitHub, Git, persistence, or API failures.

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/config.ts`
- Create: `lib/errors.ts`
- Test: `tests/backend.test.ts`

**Key Decisions / Notes:**

- Install `vitest@4.1.10` and update `@types/node` to `24.13.3`; set `engines.node` to `>=24.15.0` and add `test`/`typecheck` scripts without adding a UI-unit-test stack.
- Define and export these exact boundaries:

  ```ts
  interface RuntimeConfig {
    organization: string;
    token: string;
    dataDir: string;
    syncIntervalMs: number;
    gitOperationTimeoutMs: number;
  }

  function loadConfig(env?: NodeJS.ProcessEnv): RuntimeConfig;
  function sanitizeError(error: unknown, secrets: readonly string[]): string;
  ```

- Read `GITHUB_ORG`, `GITHUB_TOKEN`, `MIRROR_DATA_DIR`, `SYNC_INTERVAL_MINUTES`, and `GIT_OPERATION_TIMEOUT_MINUTES`; trim text, resolve `MIRROR_DATA_DIR` with a local default of `./mirror-data`, default the two durations to 60 minutes, and reject missing, non-numeric, non-integer, zero, or negative values before opening storage.
- Redact the literal token, URL-encoded token, and HTTPS user-info from a bounded error string; return a stable generic message for non-error thrown values that cannot be rendered safely.

**Definition of Done:**

- [ ] Valid configuration produces exact millisecond durations and a resolved data path; every invalid boundary above throws a configuration error naming the field but never the token value.
- [ ] Error tests prove raw tokens, URL-encoded tokens, and credential-bearing URLs are absent from normalized output.
- [ ] Verify: `npm test -- tests/backend.test.ts --reporter=dot`

### Task 2: Persist repository and queue state transactionally

**Objective:** Create the SQLite persistence layer used by both services. It must atomically reconcile complete discovery results, deduplicate work, claim jobs, preserve prior successes across failures, recover interrupted work, and provide one serializable dashboard snapshot.

**Files:**

- Create: `lib/contracts.ts`
- Create: `lib/store.ts`
- Modify: `tests/backend.test.ts`

**Key Decisions / Notes:**

- Initialize `mirrormirror.db` with foreign keys, WAL, a busy timeout, `PRAGMA user_version = 1`, timestamps stored as ISO-8601 UTC text, parameterized statements, and this state shape:

  ```sql
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
  ```

- Export `openStore(dataDir)` for explicitly owned worker/test connections and a process-cached `getStore(dataDir)` for the polling web hot path. Both return methods named `reconcileRepositories`, `recordDiscoveryFailure`, `enqueueRepository`, `enqueueAllAvailable`, `beginScheduledCycle`, `claimNextScheduled`, `completeScheduledMember`, `finishScheduledCycle`, `claimNextManual`, `completeSync`, `recoverInterrupted`, `writeHeartbeat`, `getHealth`, and `getDashboardSnapshot`.
- Reconcile by numeric GitHub ID in one `BEGIN IMMEDIATE` transaction: update names/URLs, mark returned repositories available, queue new/never-synced repositories, and set `is_available = 0` for absent repositories without deleting their row, mirror path, or prior sync state.
- A successful complete reconciliation clears `runtime_state.discovery_error` in the same transaction; `recordDiscoveryFailure` changes only that error field.
- `beginScheduledCycle` snapshots the accessible repository IDs into `scheduled_cycle_members`. `claimNextScheduled` processes each incomplete member at most once; `completeScheduledMember` updates the repository outcome and member completion in one transaction; `finishScheduledCycle` atomically clears `active_cycle_id` and writes the next due time only after the fixed batch is complete. Manual requests accepted after a member completes remain queued until that cycle finishes.
- `claimNextManual` claims the oldest manual row only when no scheduled cycle is active. Enqueue returns `accepted: false` for `queued` or `syncing`; completion updates state while retaining `last_success_at` after failure and clearing `last_error` after success. Startup recovery moves every `syncing` row back to `queued` without completing its cycle member.
- Derive the public status with active work first, then availability, then sync state: `queued`/`syncing` remain visible during an unavailable-repository retry; otherwise `is_available = 0` renders as `unavailable` while retaining the last Git outcome underneath.
- Open two store connections in tests to exercise busy handling and ensure a repository can only be claimed once.

**Definition of Done:**

- [ ] Tests cover initial discovery, rename by stable ID, complete-list disappearance, unavailable data retention, queue deduplication, global exclusion of unavailable repositories, fixed scheduled membership, atomic claims, manual requeue after an early cycle member completes, success clearing a prior error, failure after prior success, interrupted recovery, and persistence after close/reopen.
- [ ] A failed discovery can update only `runtime_state.discovery_error`; repository availability and queued work remain byte-for-byte unchanged.
- [ ] A failure-then-success discovery sequence clears the persisted global error, including after closing and reopening the store.
- [ ] Verify: `npm test -- tests/backend.test.ts --reporter=dot`

### Task 3: Discover every accessible GitHub repository

**Objective:** Implement one dependency-injectable GitHub REST client that gathers and validates all repository pages before returning any result. It must classify authentication, permission, rate-limit, malformed-response, and transport errors without leaking credentials.

**Files:**

- Create: `lib/github-client.ts`
- Modify: `tests/backend.test.ts`

**Key Decisions / Notes:**

- Export `listOrganizationRepositories(config, fetchImpl = fetch)` returning validated records with `githubId`, `name`, `fullName`, and token-free HTTPS `cloneUrl`.
- Start with the encoded `GITHUB_ORG` at `/orgs/{org}/repos?type=all&per_page=100`; resolve `rel="next"` links and accept them only when they use HTTPS, contain no user-info, have exact host `api.github.com`, and retain the expected `/orgs/{encoded-org}/repos` path.
- Send requests with `redirect: "error"`, track every normalized page URL in a visited set, and reject cross-origin links, redirect responses, or repeated/cyclic pagination before attaching the authorization header to another request.
- Send `Accept: application/vnd.github+json`, `Authorization: Bearer`, `User-Agent: mirror-mirror`, and `X-GitHub-Api-Version: 2026-03-10` headers.
- Require a positive integer `id`, non-empty names, and an HTTPS `github.com` clone URL without user-info. Reject a duplicate ID or malformed page as a whole-result failure.
- Include HTTP status, GitHub request ID, and rate-limit reset time when present, but pass all text through `sanitizeError` before exposing it.

**Definition of Done:**

- [ ] Mocked-fetch tests cover one page, multiple `Link` pages, private/archived/fork records, duplicate IDs, invalid JSON/shape/clone URL, off-origin/user-info next links, redirect attempts, repeated/cyclic pagination, 401, 403 rate limit, 404 organization, and transport failure.
- [ ] No test observes a partial repository result after any later page fails, and no thrown message contains the token or an authorization header value.
- [ ] Verify: `npm test -- tests/backend.test.ts --reporter=dot`

### Task 4: Mirror Git repositories without risking existing data

**Objective:** Implement real Git bare-clone and update behavior with token-free arguments and remotes. Initial clones use a bounded temporary sibling and atomic rename; updates operate in place and preserve the last usable mirror when Git fails.

**Files:**

- Create: `lib/git-mirror.ts`
- Create: `scripts/git-askpass.sh`
- Test: `tests/git-mirror.integration.test.ts`

**Key Decisions / Notes:**

- Export `syncMirror(repository, config, options?)`. Invoke Git with `spawn` and argument arrays, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` pointing at the shipped script, and the token only in the child environment.
- Initial synchronization runs this logical sequence; update never reclones:

  ```text
  git clone --mirror -- TOKEN_FREE_CLONE_URL ID_SCOPED_TEMP_DIRECTORY
  atomic rename ID_SCOPED_TEMP_DIRECTORY -> MIRRORS_ROOT/GITHUB_ID.git

  git -C MIRRORS_ROOT/GITHUB_ID.git remote set-url origin TOKEN_FREE_CLONE_URL
  git -C MIRRORS_ROOT/GITHUB_ID.git remote update --prune
  ```

- Bound captured stderr, terminate the child at `gitOperationTimeoutMs`, and sanitize the final error. Before every initial retry where the final mirror is absent, resolve and validate that the deterministic temporary target is exactly the expected ID-scoped child beneath `mirrors/`, remove only that stale temp target, and recreate it; never recursively remove an established mirror.
- `scripts/git-askpass.sh` prints `x-access-token` for a username prompt and `$GITHUB_TOKEN` for a password prompt without tracing or echoing other environment values.

**Definition of Done:**

- [ ] A real local upstream fixture with multiple branches and tags clones as a bare repository, later updates in place, gains new refs, and prunes deleted upstream refs.
- [ ] A forced update failure never replaces or recursively removes the established directory: it remains a valid readable bare repository and a pre-existing commit remains addressable even if Git already advanced another ref before failing.
- [ ] A pre-created interrupted temporary clone is safely removed and retried to success without touching any established mirror; an ordinary initial failure leaves no final mirror and only the validated temporary path is cleaned.
- [ ] The stored `origin` URL, subprocess arguments, captured error, and test output never contain the configured token.
- [ ] Verify: `npm test -- tests/git-mirror.integration.test.ts --reporter=dot`

### Task 5: Execute scheduled and manual work in the dedicated worker

**Objective:** Connect configuration, discovery, persistence, and Git operations in a long-running worker with deterministic startup recovery and schedule semantics. The worker processes one repository at a time, keeps a durable heartbeat, and stops safely on SIGINT/SIGTERM.

**Files:**

- Create: `worker/scheduler.ts`
- Create: `worker/index.ts`
- Create: `tsconfig.worker.json`
- Modify: `package.json`
- Test: `tests/worker.test.ts`

**Key Decisions / Notes:**

- `runWorker(dependencies, signal)` performs: open/validate, recover interrupted jobs, start 5-second heartbeat, discover on startup, resume an active scheduled cycle or snapshot a new due cycle, drain that fixed member batch, persist `next_scheduled_at = cycle_completion + syncIntervalMs`, and only then resume manual work between cycles.
- On startup with a future persisted schedule, discovery still runs and queues newly discovered repositories, but existing healthy repositories wait for the preserved due time. Manual queue work never rewrites `next_scheduled_at`.
- If a repository that already completed its scheduled membership is manually queued while later members remain, the worker leaves that manual request pending until `finishScheduledCycle`; it never synchronizes the same repository twice as part of one scheduled batch.
- A complete discovery failure records one global error, leaves repository availability untouched, and advances a due schedule by the configured interval to prevent a tight API retry loop.
- Poll once per second because queue notifications cross processes through SQLite. Use injected clock/wait/discovery/mirror dependencies in unit tests; only GitHub/network and Git subprocess boundaries are mocked.
- Add this exact implementation ledger near the serial drain loop:

  ```ts
  // SHORTCUT: repository syncs are serial; add bounded parallelism when full-cycle duration regularly exceeds the configured interval.
  ```

- `worker/index.ts --check-config` validates configuration, creates the data directories, proves SQLite is writable, and exits; production web startup runs this before `server.js`. `--healthcheck` opens the same store and exits non-zero when the heartbeat is absent or older than 30 seconds. Normal mode handles SIGINT/SIGTERM by aborting the active Git child, returning its row to queued, and ceasing new claims before exit.
- Compile `worker/**/*.ts` plus `lib/**/*.ts` to `dist-worker/` with `tsconfig.worker.json`; add `build:worker`, `worker`, and combined `build` scripts.

**Definition of Done:**

- [ ] Fake-clock tests cover first startup, restart before/after due time, active-cycle crash recovery, new repository on startup, discovery failure then success/error clearing, one-repository failure isolation, duplicate manual/scheduled demand, an early-completed member manually requeued while a later member runs, manual work preserving schedule, heartbeat freshness, stale healthcheck, and graceful interruption/recovery.
- [ ] Every repository operation updates `last_attempt_at`; only success updates `last_success_at`; errors are sanitized before `completeSync` persists them.
- [ ] Verify: `npm test -- tests/worker.test.ts --reporter=dot && npm run build:worker`

### Task 6: Expose status, sync, and health HTTP contracts

**Objective:** Add uncached Next.js 16 Route Handlers that expose the durable snapshot and accept asynchronous manual work. Validate every path parameter at the HTTP boundary and use consistent success/error envelopes and status codes.

**Files:**

- Create: `app/api/status/route.ts`
- Create: `app/api/sync/route.ts`
- Create: `app/api/repositories/[repositoryId]/sync/route.ts`
- Create: `app/api/health/[component]/route.ts`
- Test: `tests/api.test.ts`

**Key Decisions / Notes:**

- Define these contracts without exposing `clone_url`, mirror absolute paths, configuration, or secrets:

  ```text
  GET  /api/status                         -> 200 { data: DashboardSnapshot }
  POST /api/sync                           -> 202 { data: { accepted, alreadyActive } }
  POST /api/repositories/{repositoryId}/sync -> 202 accepted, 200 already active, 404 unknown
  GET  /api/health/web                     -> 200 { data: { status: 'healthy' } }
  GET  /api/health/worker                  -> 200 healthy or 503 stale/missing
  errors                                   -> { error: { code, message } }
  ```

- Await dynamic route params as required by Next.js 16. Reject non-decimal, zero, negative, unsafe-integer, and unknown repository IDs before queue mutation.
- Require `Content-Type: application/json` on both POST routes and return 415 otherwise; this keeps browser mutations non-simple/cross-origin by default without inventing an application-authentication layer.
- Global sync queues only available repositories in one transaction. Per-repository sync may queue an unavailable repository using its retained clone URL so an operator can retry after restoring permissions.
- Mark status and health GET handlers dynamic/no-store; map expected validation/not-found errors without stack traces and sanitize unexpected failures before returning status 500.

**Definition of Done:**

- [ ] Direct handler tests cover status serialization, global accepted/already-active counts, per-repository accepted/deduplicated/unknown/invalid IDs, rejected non-JSON POSTs, unavailable retry, web health, fresh worker health, and stale worker 503.
- [ ] Every response uses the documented envelope and contains no token, authenticated URL, absolute mirror path, or stack trace.
- [ ] Verify: `npm test -- tests/api.test.ts --reporter=dot && npm run typecheck`

### Task 7: Build the MirrorMirror operations dashboard

**Objective:** Replace the starter with a focused operations ledger that server-renders an initial snapshot and hydrates only the polling/actions component. It must make healthy, failed-after-success, never-synced, queued, syncing, and unavailable states unmistakable on desktop and mobile, and satisfy TS-001 through TS-004.

**Files:**

- Modify: `app/page.tsx`
- Create: `app/mirror-dashboard.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`

**Key Decisions / Notes:**

- Keep `app/page.tsx` as a dynamic Server Component that reads `getDashboardSnapshot()` and passes serializable data to the narrow `'use client'` dashboard boundary.
- Poll `/api/status` every 2 seconds with cleanup and request cancellation. Reuse the previous snapshot when a refresh fails, show one accessible stale-data message, and avoid recomputing sorted/grouped rows unless repository data changes.
- POST JSON to the manual endpoints, announce accepted/already-active/error outcomes through `aria-live="polite"`, refresh immediately after an action, and disable only controls whose work is queued/syncing or submitting.
- Use an industrial operations-console direction: IBM Plex Sans/Mono, warm paper and ink colors, restrained green/amber/red status tokens, a dense ledger rather than repeated cards, no gradients/glass/side-stripe accents, one `h1`, semantic buttons/table or description lists, visible focus, and 44-pixel minimum actions.
- Preserve exact timestamps in `<time datetime>` with readable local display; show `last_success_at` independently from the current attempt and expose sanitized errors without color-only meaning.

**Definition of Done:**

- [ ] Loading, empty, healthy, never-synced, queued, syncing, failed-after-success, unavailable, worker-offline, refresh-error, and action-result states are readable and keyboard operable.
- [ ] The dashboard has no horizontal page overflow at 390 CSS pixels, no heading/container overflow, and every action remains reachable and at least 44 CSS pixels high.
- [ ] Verify: `npm run build && npm run lint`

### Task 8: Build one production image for web and worker

**Objective:** Produce a pinned, non-privileged multi-stage Docker image containing Next.js standalone output, compiled worker output, Git, CA certificates, static assets, and the askpass helper. The same image must support the web command and worker command without shipping build dependencies.

**Files:**

- Modify: `next.config.ts`
- Create: `Dockerfile`
- Create: `.dockerignore`

**Key Decisions / Notes:**

- Set `output: "standalone"`; copy `.next/standalone`, `.next/static`, `public`, `dist-worker`, and `scripts/git-askpass.sh` into the runtime stage.
- Use `node:24.18.0-bookworm-slim` for build and runtime, install only `git` and `ca-certificates` in the runtime stage, set `NODE_ENV=production`, and run as the image's UID/GID 1000 `node` user.
- The default image command runs `node dist-worker/worker/index.js --check-config` and then `exec node server.js` with `HOSTNAME=0.0.0.0`; Compose overrides only the worker command. Use Compose `init: true` rather than embedding a supervisor.
- Ensure the askpass script is executable and readable by the runtime user; do not bake `.env`, mirror data, SQLite files, `.git`, `.codegraph`, `node_modules`, or local build output into the image.

**Definition of Done:**

- [ ] `docker build` succeeds from a clean context and image inspection confirms Node 24.18.0, Git, web standalone files, worker output, and an executable askpass helper.
- [ ] Both `node server.js` and `node dist-worker/worker/index.js --healthcheck` start from the final stage without development dependencies or privileged/container-socket access.
- [ ] Verify: `docker build --tag mirror-mirror:spec .`

### Task 9: Wire Compose deployment and operator documentation

**Objective:** Deliver the supported Docker Compose workflow and synchronize the README with every operator-facing setting and limitation. Both services share one host directory, report distinct health, and give actionable startup failures when configuration or mount permissions are wrong.

**Files:**

- Create: `compose.yaml`
- Create: `.env.example`
- Modify: `.gitignore`
- Modify: `README.md`

**Key Decisions / Notes:**

- Define `web` and `worker` from the same build/image, `init: true`, `restart: unless-stopped`, the same read/write `${MIRROR_HOST_PATH:-./mirror-data}:/data` bind mount, and the same `GITHUB_ORG`, `GITHUB_TOKEN`, `SYNC_INTERVAL_MINUTES`, and `GIT_OPERATION_TIMEOUT_MINUTES` environment.
- Map `${MIRRORMIRROR_PORT:-3000}:3000` only on `web`. Use `/api/health/web` for web health and `node dist-worker/worker/index.js --healthcheck` for worker health; do not use the Docker socket or privileged mode.
- `.env.example` contains names and safe defaults but a blank token. `.gitignore` explicitly keeps `.env.example` while excluding `mirror-data/` and `dist-worker/`.
- README steps: create/correct ownership of the host directory for UID/GID 1000, copy `.env.example`, grant a fine-grained PAT repository **Metadata: read** and **Contents: read** access, start/inspect/stop Compose, locate `mirrors/{github-id}.git`, force sync from the dashboard, interpret status/health, rotate credentials, and understand every PRD exclusion.

**Definition of Done:**

- [ ] `docker compose config` resolves two services, one shared bind mount, one published web port, separate health checks, no privileged mode, and no Docker socket mount.
- [ ] Against a fresh writable host directory, Compose starts the web service and worker; invalid GitHub credentials produce a sanitized discovery error without marking seeded repositories unavailable or exposing the token in `docker compose logs`.
- [ ] README commands, environment names/defaults, PAT permissions, host layout, health semantics, and limitations match the shipped Compose and application behavior exactly.
- [ ] Verify: `docker compose config --quiet && npm test -- --reporter=dot && npm run typecheck && npm run lint && npm run build`
