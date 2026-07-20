# MirrorMirror GitHub Organization Repository Mirroring

Created: 2026-07-20
Author: josh@luongo.com.au
Agent: Codex
Category: Feature
Status: Final
Research: Quick

## Problem Statement

Operators need a simple, self-hosted way to keep complete Git mirrors of every repository in a GitHub organization without maintaining individual clone jobs or manually checking whether repositories have changed. MirrorMirror will discover repositories, maintain bare Git mirrors on a host-mounted folder, expose clear synchronization health, and let an operator request an early sync from a small web dashboard.

## Core User Flows

### Flow 1: Start MirrorMirror and create the initial mirrors

1. The operator configures a GitHub organization, a personal access token, a host storage folder, and optionally a sync interval.
2. The operator starts the application with Docker Compose.
3. MirrorMirror validates its required configuration without exposing the token, discovers every repository in the configured organization that the token can access, and queues an initial sync.
4. For each repository, MirrorMirror creates a bare Git mirror in a deterministic location beneath the host-mounted folder.
5. The dashboard shows progress independently for each repository so one slow or failed mirror does not hide the state of the others.

### Flow 2: Keep mirrors current automatically

1. After a synchronization cycle completes, MirrorMirror waits for the configured interval, which defaults to 60 minutes.
2. At the start of the next cycle, MirrorMirror refreshes the organization repository list so newly created, renamed, archived, or newly accessible repositories are recognized.
3. MirrorMirror synchronizes every accessible repository, including all Git branches, tags, and Git refs, and prunes refs that no longer exist upstream.
4. MirrorMirror records the outcome and timing for each repository and continues processing other repositories when an individual sync fails.
5. The dashboard reflects the latest persisted state and the next scheduled cycle.

### Flow 3: Force an early synchronization

1. The operator opens the dashboard and reviews mirror status.
2. The operator selects **Sync now** for one repository or **Sync all** for every accessible repository.
3. MirrorMirror queues the request immediately without starting a second concurrent sync for a repository that is already queued or running.
4. The dashboard shows the queued and running states, then the final success or failure result.
5. A manual synchronization does not disable or permanently shift the recurring schedule.

### Flow 4: Investigate a failed or unavailable mirror

1. The operator sees a repository in a failed or unavailable state.
2. The dashboard shows when the last attempt occurred, when the last successful sync occurred, and a sanitized error summary.
3. The operator can correct credentials, permissions, connectivity, or upstream state and request another sync.
4. If a repository was removed from GitHub or became inaccessible, MirrorMirror retains its host data and status record; it never deletes that data automatically.

## Scope

### In Scope

- One configured GitHub organization per MirrorMirror deployment.
- Discovery of all repositories returned for that organization and accessible to the configured token, including private, public, internal, archived, and forked repositories when GitHub permits access.
- GitHub authentication through a personal access token supplied as deployment configuration and never rendered in the UI or written to logs.
- Bare Git mirrors containing the Git objects and refs available through the repository's Git clone endpoint, including every branch and tag.
- Initial cloning, subsequent remote updates, and pruning of upstream-deleted refs.
- A host bind mount for durable repository storage so mirrors remain after containers are recreated.
- A configurable recurring interval with a default of 60 minutes.
- Repository discovery on worker startup and at the beginning of each scheduled cycle.
- Durable synchronization metadata across container restarts.
- Per-repository synchronization states that distinguish at least: never synchronized, queued, synchronizing, healthy, failed, and unavailable.
- A dashboard listing repository name, synchronization state, last attempt, last successful sync, latest sanitized error, and next scheduled cycle.
- Per-repository **Sync now** actions and one global **Sync all** action.
- Deduplication of queued or active work so the same repository is never synchronized concurrently.
- Failure isolation so one repository failure does not stop the remaining synchronization cycle.
- Safe handling of repository renames without creating two active records for the same GitHub repository.
- Preservation of an existing mirror when its repository disappears from discovery or becomes inaccessible.
- Clear startup failure for invalid required configuration and visible operational errors for GitHub, filesystem, and Git failures.
- A Docker Compose workflow that runs the web interface and background synchronization worker from the same application source and image.
- A responsive, keyboard-accessible dashboard suitable for use on a trusted local network.

### Explicitly Out of Scope

- Git LFS object payloads — a bare Git mirror covers Git objects and refs but not separately stored LFS content.
- Checked-out working trees — stored repositories are bare mirrors intended for replication and recovery tooling.
- Recursive mirroring of submodule repositories — submodule links remain in Git history, but their referenced repositories are not discovered through the parent repository.
- GitHub issues, pull requests, releases, Actions artifacts, packages, wikis, secrets, settings, and other non-Git metadata.
- Automated restore or push-back workflows — the MVP creates and updates mirrors only.
- Multiple GitHub organizations in one deployment.
- GitHub App, OAuth, or SSH-key authentication.
- Dashboard authentication, user accounts, or role-based authorization — deployment is limited to a trusted network for the MVP.
- Webhook-triggered synchronization — synchronization is scheduled or manually requested.
- Automatic deletion of local repository data for any reason.
- Historical snapshots beyond the current mirrored Git ref state.
- Per-repository schedules, exclusion rules, or custom retention policies.

## Product Requirements

### Repository identity and discovery

- MirrorMirror must use GitHub's stable repository identity to reconcile discovery results so renames do not create duplicate active mirrors.
- GitHub pagination must not cause repositories to be omitted from organizations with more than one response page.
- MirrorMirror must only mark previously known repositories unavailable after a complete, successful organization discovery; an API, authentication, pagination, or rate-limit failure must preserve their prior availability state and surface the discovery failure separately.
- A repository first seen during discovery must appear in the dashboard and be queued for its initial mirror.
- A previously known repository absent from discovery must be marked unavailable without removing its files.

### Synchronization behavior

- Synchronization must operate on one repository at a time per repository identity; duplicate scheduled and manual requests must collapse into one pending or active operation.
- A successful synchronization means the local bare repository accepted a complete Git remote update and its local refs reflect the refs exposed by the upstream clone endpoint at that time.
- A failed update must not replace or deliberately delete the last usable local mirror.
- An interrupted operation must be recoverable on worker restart and eligible for the next scheduled or manual attempt.
- Manual actions must return control to the web interface after durable queue acceptance rather than holding the web request open for the full Git operation.
- Scheduled cycles must not overlap. The interval begins after the current scheduled cycle completes, while a manual sync leaves the recurring schedule unchanged.

### Status and dashboard behavior

- Status must be based on durable synchronization state, not solely on whether a web request succeeded.
- Repository rows must provide enough information to distinguish a mirror that has never succeeded from one whose latest attempt failed after an earlier successful sync.
- Time values must be displayed consistently and identify the timezone or use an unambiguous relative-time presentation with access to the exact timestamp.
- Manual controls must communicate when work is accepted, already queued, already running, completed, or rejected.
- The global action must not create duplicate work for repositories already queued or running.
- Error summaries must be actionable but must not include the personal access token or authenticated clone URL credentials.

### Configuration and operations

- The GitHub organization, personal access token, host mirror location, and sync interval must be configurable without rebuilding the image.
- The interval must accept the documented 60-minute default and reject invalid or non-positive values at startup.
- The application services must run without requiring privileged mode or access to the host Docker socket.
- The deployment must expose a health signal that distinguishes a serving web process from an operational background worker.
- Container shutdown and restart must not corrupt the durable status store or an existing usable Git mirror.

## Success Criteria

- Starting Docker Compose with valid configuration discovers and mirrors every repository visible to the configured token.
- Each resulting directory is a valid bare Git repository whose branches, tags, and refs match the refs exposed by its GitHub upstream after a successful cycle.
- Repository data remains present and reusable after the application containers are removed and recreated with the same host mount.
- A subsequent cycle updates existing mirrors without recloning healthy repositories from scratch.
- A repository added to GitHub appears and begins its initial sync during the next discovery cycle without configuration changes.
- A per-repository manual request and a global manual request both produce durable, observable queued work and never cause concurrent operations for the same repository.
- A failure for one repository is visible in the dashboard and does not prevent other repositories from completing.
- A removed or inaccessible repository remains on disk and is visibly marked unavailable.
- With no interval override, the next scheduled cycle begins 60 minutes after the preceding scheduled cycle completes.
- The personal access token is absent from rendered pages, persisted error messages, and normal application logs.

## Technical Context

- **Relevant architecture:** The repository is a stock Next.js 16 App Router application. The recommended deployment uses separate web and synchronization-worker services built from the same source/image, with shared durable job and status state plus the host-mounted mirror root.
- **Constraints:** The entire product must run through Docker Compose; Git operations execute in the background rather than inside long-lived web requests; repository storage must be directly available on the host; the implementation must follow the bundled Next.js 16 documentation in `node_modules/next/dist/docs/` because this version differs from earlier Next.js conventions.
- **Existing code:** `app/page.tsx` contains the starter page; `app/layout.tsx` and `app/globals.css` provide the current shell and styling; `package.json` contains only the standard Next.js, React, TypeScript, Tailwind, build, lint, and start dependencies. No Docker, GitHub integration, persistence, scheduler, API, or application test infrastructure exists yet.
- **Implementation boundary:** The exact persistence library, queue representation, concurrency limit across different repositories, API route shape, health-check mechanism, and filesystem naming convention are technical-design decisions for `$spec`, provided they satisfy the behaviors and safety constraints above.

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Repository representation | Bare Git mirror | Accurately preserves all Git branches, tags, and refs without maintaining a working tree. |
| GitHub authentication | Personal access token from deployment configuration | Keeps setup simple while supporting private and internal repositories when correctly scoped. |
| Manual controls | Per-repository **Sync now** and global **Sync all** | Supports both targeted recovery and an organization-wide early refresh. |
| Default schedule | 60 minutes after each scheduled cycle completes | Reduces GitHub and host load while providing predictable recurring updates without overlapping cycles. |
| Runtime shape | Separate web and worker services from one image | Keeps long-running Git work independent of Next.js request handling while retaining a simple Compose deployment. |
| Missing repositories | Retain mirror and mark unavailable | Prevents unexpected or irreversible loss when a repository is deleted or permissions temporarily change. |
| Dashboard security | Trusted-network access without application authentication | Avoids account-management scope in the MVP; network exposure remains an operator responsibility. |
| Product category | Feature | The work delivers the product's primary end-to-end capability rather than an isolated infrastructure component. |
