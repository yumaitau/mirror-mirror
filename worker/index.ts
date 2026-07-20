import { loadConfig } from "../lib/config";
import { syncMirror } from "../lib/git-mirror";
import { listOrganizationRepositories } from "../lib/github-client";
import { openStore } from "../lib/store";
import { isWorkerHealthy, runWorker } from "./scheduler";

const WORKER_STALE_AFTER_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const store = openStore(config.dataDir);
  const mode = process.argv[2];

  if (mode === "--check-config") {
    store.close();
    return;
  }
  if (mode === "--healthcheck") {
    const healthy = isWorkerHealthy(
      store.getHealth(),
      new Date(),
      WORKER_STALE_AFTER_MS,
    );
    store.close();
    if (!healthy) {
      process.exitCode = 1;
    }
    return;
  }
  if (mode) {
    store.close();
    throw new Error(`Unknown worker option: ${mode}`);
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await runWorker(
      {
        config,
        store,
        discover: () => listOrganizationRepositories(config),
        mirror: (repository, signal) =>
          syncMirror(repository, config, { signal }),
      },
      controller.signal,
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    store.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Worker failed.";
  console.error(message);
  process.exitCode = 1;
});
