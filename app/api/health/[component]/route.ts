import {
  dataResponse,
  errorResponse,
  unexpectedErrorResponse,
} from "../../api-response";
import { loadConfig } from "../../../../lib/config";
import { getStore } from "../../../../lib/store";
import { isWorkerHealthy } from "../../../../worker/scheduler";

export const dynamic = "force-dynamic";

interface HealthContext {
  params: Promise<{ component: string }>;
}

export async function GET(
  _request: Request,
  context: HealthContext,
): Promise<Response> {
  const { component } = await context.params;
  if (component === "web") {
    return dataResponse({ status: "healthy" });
  }
  if (component !== "worker") {
    return errorResponse("UNKNOWN_COMPONENT", "Health component not found.", 404);
  }

  try {
    const config = loadConfig();
    const healthy = isWorkerHealthy(
      getStore(config.dataDir).getHealth(),
      new Date(),
      30_000,
    );
    if (!healthy) {
      return errorResponse(
        "WORKER_UNAVAILABLE",
        "The synchronization worker heartbeat is stale or missing.",
        503,
      );
    }
    return dataResponse({ status: "healthy" });
  } catch (error) {
    return unexpectedErrorResponse(error);
  }
}
