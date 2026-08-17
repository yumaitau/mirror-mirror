# MirrorMirror Git LFS Support

Created: 2026-07-20
Author: josh@luongo.com.au
Agent: Codex
Category: Feature
Status: Final
Research: Quick

## Problem Statement

MirrorMirror currently preserves Git objects and refs but does not download the payloads referenced by Git LFS pointer files. Operators therefore cannot treat a healthy mirror as a complete repository backup when a repository uses Git LFS. MirrorMirror must include all LFS payloads referenced by the repository's mirrored refs in the normal synchronization lifecycle, without adding a separate workflow or weakening its existing no-automatic-deletion policy.

## Core User Flows

### Flow 1: Create a complete mirror of a Git LFS repository

1. The operator starts MirrorMirror with the existing GitHub organization, token, and durable host storage configuration.
2. MirrorMirror discovers a repository that uses Git LFS and runs its normal initial synchronization.
3. MirrorMirror mirrors the repository's Git refs and downloads every LFS payload referenced by every mirrored ref.
4. The repository becomes healthy only after both the Git and LFS portions complete successfully.
5. The dashboard shows the existing healthy state and a total mirror size that includes the stored LFS payloads.

### Flow 2: Keep LFS payloads current

1. A scheduled or manual synchronization updates the repository's Git refs.
2. MirrorMirror downloads any LFS payloads newly referenced by any mirrored branch, tag, or other ref.
3. Payloads fetched during earlier successful synchronizations remain on disk even when their upstream refs are later removed.
4. The repository's last-success timestamp and total mirror size update only after the complete Git-and-LFS synchronization succeeds.

### Flow 3: Recover from an LFS synchronization failure

1. An LFS download fails because of authentication, authorization, network, upstream, storage, timeout, or tooling errors.
2. MirrorMirror marks that repository's latest attempt as failed, retains its prior successful timestamp and measured size, and preserves all previously downloaded Git and LFS data.
3. The dashboard presents the failure through the existing repository status and sanitized error summary.
4. MirrorMirror continues processing the remaining repositories in the cycle.
5. After the operator corrects the cause, **Sync now** retries the full repository synchronization through the existing queue.

## Scope

### In Scope

- Initial and subsequent download of all Git LFS payloads referenced by every ref present in each bare mirror after its Git update.
- Git LFS support for every repository discovered through the existing single-organization workflow, with no per-repository enablement step.
- Use of the existing GitHub token and non-interactive Git credential path for authorized LFS downloads, including private repositories the token can access.
- One combined repository synchronization outcome: Git and LFS must both succeed before an attempt is recorded as successful.
- Preservation of previously fetched LFS payloads; MirrorMirror must not automatically prune or delete them when upstream refs change.
- Existing timeout, cancellation, credential-sanitization, queue durability, per-repository serialization, and failure-isolation behavior applied to LFS work.
- Existing dashboard states and manual actions, with total mirror size including LFS payload storage after a successful sync.
- Clear operational documentation that Git LFS payloads are mirrored, retained, included in size reporting, and covered by the repository's overall sync status.
- Packaging the required Git LFS tooling in the supported Docker deployment so no manual container setup is required.
- Regression coverage for repositories with no LFS pointers so ordinary Git mirrors retain their current behavior.

### Explicitly Out of Scope

- A separate LFS status, byte count, progress indicator, enablement toggle, or retry action in the dashboard — LFS is part of the existing repository sync contract.
- Automatic pruning, garbage collection, quotas, retention windows, or deduplication of LFS payloads — preservation is favored over storage reclamation.
- Downloading LFS payloads not referenced by any ref that MirrorMirror can obtain from the upstream repository.
- Automated restore, checkout, push-back, or LFS serving workflows — this feature stores the payloads needed for recovery but does not add recovery tooling.
- Migration of LFS payloads that may already exist outside MirrorMirror's managed repository directories.
- New authentication methods, providers, organizations, repository filters, or per-repository configuration.
- GitHub release assets or other non-GitHub-LFS binary storage.

## Product Requirements

### Completeness and success semantics

- A repository synchronization must not be recorded as successful until all Git refs have updated and every LFS payload referenced by those refs has been downloaded successfully.
- LFS completeness must cover all mirrored refs rather than only the default branch or current checkout.
- A repository that does not use Git LFS must complete without special configuration or a distinct status path.
- A failed LFS phase must retain the repository's prior last-success timestamp and successfully measured size, while recording the new failed attempt and its sanitized error.
- A failed or interrupted attempt must not deliberately remove previously downloaded Git objects or LFS payloads. Ref changes already accepted by the underlying in-place Git update do not need to be rolled back, but the repository must remain non-healthy until a complete retry succeeds.

### Storage and retention

- LFS payloads must be stored within the repository's existing durable mirror area beneath the configured host mount so container recreation preserves them.
- Successfully fetched LFS payloads must remain on disk when an upstream branch, tag, or other ref is removed.
- MirrorMirror must not introduce an automatic LFS prune or garbage-collection path.
- The persisted mirror-size measurement after a successful synchronization must include both ordinary Git data and LFS payload storage.
- A failed synchronization must not replace the last successfully measured size with a partial or failed-attempt measurement.

### Authentication, errors, and operations

- LFS downloads must use the existing configured GitHub token without embedding credentials in command arguments, persisted remotes, dashboard responses, or logs.
- Authentication and error sanitization must cover LFS-specific command output and URLs as well as the existing Git path.
- Missing or unusable Git LFS tooling in the supported runtime must produce a clear operational failure rather than silently completing a Git-only mirror.
- Existing operation cancellation and per-repository timeout behavior must include LFS work so shutdown cannot leave an attempt reported as successful.
- An LFS failure in one repository must not stop synchronization of other repositories in the same scheduled or manual cycle.

### Dashboard and documentation

- The existing repository state, timestamps, sanitized error, **Sync now**, and **Sync all** controls must represent the combined Git-and-LFS operation.
- No additional operator action may be required to enable LFS for a discovered repository.
- The README must remove the current Git-LFS limitation and explain completeness, retention, size accounting, failure behavior, storage growth, and the continuing absence of automated restore tooling.

## Success Criteria

- An initial sync of a repository with LFS pointers across multiple branches or tags stores every corresponding payload in durable mirror storage and reports the repository healthy.
- A later sync downloads newly referenced LFS payloads without recloning the repository or re-downloading already available payloads unnecessarily.
- Removing an upstream ref does not cause MirrorMirror to delete LFS payloads it previously fetched.
- Recreating the web and worker containers against the same host mount preserves the fetched LFS payloads and existing synchronization state.
- An LFS authentication, network, timeout, storage, or upstream failure marks only that repository's attempt failed, preserves its prior successful metadata and data, exposes no credential, and allows the cycle to continue.
- Retrying after the failure is corrected produces one healthy combined Git-and-LFS result through the existing queue and controls.
- The mirror-size value stored after success includes LFS payload bytes, while a failed attempt leaves the prior successful value unchanged.
- A repository without Git LFS continues to synchronize successfully through the same workflow.
- The supported Docker image contains working Git LFS tooling without operator installation steps.

## Technical Context

- **Relevant architecture:** `worker/scheduler.ts` serially runs repository sync jobs and persists one combined `SyncOutcome`; `lib/git-mirror.ts` performs in-place bare-mirror clone/update work and measures the mirror directory only after success; `lib/store.ts` retains last-success metadata and mirror size; `app/mirror-dashboard.tsx` renders that persisted state.
- **Constraints:** MirrorMirror runs as web and worker services from one Docker image, uses a host-mounted `/data` directory, performs Git work only in the worker, passes GitHub credentials through the existing non-interactive askpass path, and does not automatically delete mirror data.
- **Existing code:** `lib/git-mirror.ts`, `worker/scheduler.ts`, `worker/index.ts`, `Dockerfile`, `scripts/git-askpass.sh`, `tests/git-mirror.integration.test.ts`, `tests/worker.test.ts`, and `README.md` are the primary integration points. The exact Git LFS command sequence and test fixtures belong in `$spec`.
- **Compatibility:** Existing mirrors must gain LFS payloads on their next successful synchronization without a manual migration or reclone. Repositories without LFS must remain behaviorally unchanged.

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| LFS coverage | All payloads referenced by every mirrored ref | A default-branch-only copy would not satisfy complete repository recovery needs. |
| Success contract | Git and LFS form one required synchronization outcome | A healthy state must mean the mirror is complete, not merely that its pointer files were copied. |
| Retention | Never automatically prune fetched LFS payloads | This matches MirrorMirror's existing preservation-first, no-automatic-deletion policy. |
| Dashboard behavior | Reuse the existing integrated status, controls, and total size | Operators need one truthful repository health signal rather than a parallel LFS workflow. |
| Deployment | Include Git LFS tooling in the supported image | LFS support must work through the documented Docker Compose setup without manual container changes. |
| Product category | Feature | This expands the end-to-end mirroring capability visible through existing product behavior. |
