# MirrorMirror

MirrorMirror keeps durable bare Git mirrors for every repository a token can read in one GitHub organization. A dedicated worker discovers repositories and synchronizes every branch and tag; the web dashboard reports health and lets an operator queue one repository or the whole organization early.

## Requirements

- Docker with Docker Compose
- A host directory Docker can bind-mount read/write
- A fine-grained GitHub personal access token for the target organization with repository access and these repository permissions:
  - **Metadata: read**
  - **Contents: read**

The token must be able to list the organization repositories it is expected to mirror, including private repositories.

## Configure and start

```bash
cp .env.example .env
mkdir -p mirror-data
docker compose up --build --detach
docker compose ps
```

Set `GITHUB_ORG` and `GITHUB_TOKEN` in `.env` before starting. At startup, each container grants UID/GID `1000` access only to the mounted data root and its `mirrors` directory, then drops privileges before running the application. Existing mirror contents are not recursively re-owned.

Open `http://localhost:3000` by default. To inspect or stop the deployment:

```bash
docker compose logs --follow web worker
docker compose down
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_ORG` | Yes | none | GitHub organization login to discover. |
| `GITHUB_TOKEN` | Yes | none | Fine-grained PAT used only by the worker for GitHub API and Git authentication. |
| `MIRROR_HOST_PATH` | No | `./mirror-data` | Host directory bind-mounted read/write at `/data` by both services. |
| `MIRRORMIRROR_PORT` | No | `3000` | Host port published by the web service. |
| `SYNC_INTERVAL_MINUTES` | No | `60` | Whole minutes between completion of one scheduled cycle and the next due cycle. |
| `GIT_OPERATION_TIMEOUT_MINUTES` | No | `60` | Whole-minute timeout for one Git clone or update command. |

All duration values must be positive whole numbers. Rotate a credential by updating `GITHUB_TOKEN` in `.env` and recreating both services:

```bash
docker compose up --detach --force-recreate web worker
```

Credentials are passed to Git through an askpass helper, not stored in Git remotes or shown by the dashboard. Treat Compose configuration and the host environment as sensitive because they contain the token.

## Data and synchronization behavior

The shared host directory contains:

```text
mirror-data/
|-- mirrormirror.db
`-- mirrors/
    `-- <github-repository-id>.git/
```

`mirrormirror.db` persists discovery state, queue work, attempt/success timestamps, the last successfully measured mirror size, worker heartbeat, and the next schedule. Repository directories are bare mirrors named by stable numeric GitHub repository ID, so a rename does not move or reclone the mirror.

The first successful discovery queues new repositories. Scheduled cycles use a fixed repository list and run serially. Existing mirrors update in place with `remote update --prune`; removed upstream refs are pruned. After Git succeeds, the worker measures the bare repository's apparent file bytes without following symbolic links and persists that value with the success state. Dashboard polling reads the stored value rather than scanning mirror directories. A repository no longer returned by discovery remains on disk and appears as **Unavailable** rather than being deleted. Recreating either container against the same host directory preserves files, queued work, timestamps, measured sizes, and schedule.

Use **Sync now** on one row or **Sync all** in the dashboard to queue an early synchronization. Requests are durable even while the worker is offline. Active rows show **Queued** or **Synchronizing** and cannot be queued twice.

Repositories created before mirror-size tracking show **Not measured** until their next successful synchronization. The displayed IEC value (for example, `1.5 KiB`) represents apparent Git repository bytes, not filesystem allocated blocks, and retains the last successful measurement when a later sync fails.

## Status and health

- **Healthy**: the latest attempt succeeded.
- **Failed**: the latest attempt failed; an earlier success timestamp remains visible when present.
- **Queued / Synchronizing**: durable work is waiting or active.
- **Never synced**: no successful attempt has completed.
- **Unavailable**: the last complete discovery no longer returned the repository; retained data is not deleted.
- **Worker offline**: the heartbeat is missing or older than 30 seconds. New requests still remain queued.

The web health endpoint is `/api/health/web`. The worker has a distinct durable heartbeat check inside its container. `docker compose ps` reports each service independently. A discovery failure is shown globally and does not mark previously known repositories unavailable; the next scheduled discovery retry is deferred by the configured interval.

## Limitations

- Mirrors are Git bare repositories only. Git LFS objects are not fetched.
- GitHub release assets, issues, pull-request metadata, Actions artifacts, packages, wikis, and other non-Git repository data are not mirrored.
- Removed or inaccessible repositories are retained indefinitely; cleanup is an operator decision.
- Synchronization is serial. Large organizations whose full cycle regularly exceeds the interval may need bounded parallelism in a future version.
- The dashboard has no application authentication. Publish it only on a trusted network or behind an external authenticated reverse proxy.
- Mirror integrity is Git's responsibility; MirrorMirror does not encrypt, compress, deduplicate, or back up the host directory.

## Local development

This project requires Node.js `24.15.0` or newer.

```bash
npm ci
cp .env.example .env
npm run dev
```

Run the worker in a second terminal after compiling it:

```bash
npm run build:worker
npm run worker
```

Tests and quality checks:

```bash
npm test -- --reporter=dot
npm run typecheck
npm run lint
npm run build
npm run test:docker-permissions
```
