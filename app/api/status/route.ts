import { dataResponse, unexpectedErrorResponse } from "../api-response";
import { loadConfig } from "../../../lib/config";
import { sanitizeError } from "../../../lib/errors";
import { getStore } from "../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const config = loadConfig();
    const snapshot = getStore(config.dataDir).getDashboardSnapshot(
      new Date(),
      30_000,
    );
    const sensitiveValues = [config.token, config.dataDir];
    return dataResponse({
      ...snapshot,
      repositories: snapshot.repositories.map((repository) => ({
        ...repository,
        latestError: repository.latestError
          ? sanitizeError(repository.latestError, sensitiveValues)
          : null,
      })),
      scheduler: {
        ...snapshot.scheduler,
        discoveryError: snapshot.scheduler.discoveryError
          ? sanitizeError(snapshot.scheduler.discoveryError, sensitiveValues)
          : null,
      },
    });
  } catch (error) {
    return unexpectedErrorResponse(error);
  }
}
