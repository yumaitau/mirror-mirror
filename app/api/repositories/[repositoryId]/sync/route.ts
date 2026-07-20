import {
  acceptsJson,
  dataResponse,
  errorResponse,
  unexpectedErrorResponse,
} from "../../../api-response";
import { loadConfig } from "../../../../../lib/config";
import { getStore } from "../../../../../lib/store";

interface RepositorySyncContext {
  params: Promise<{ repositoryId: string }>;
}

export async function POST(
  request: Request,
  context: RepositorySyncContext,
): Promise<Response> {
  if (!acceptsJson(request)) {
    return errorResponse(
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
      415,
    );
  }

  const { repositoryId: rawRepositoryId } = await context.params;
  if (!/^[1-9]\d*$/.test(rawRepositoryId)) {
    return errorResponse(
      "INVALID_REPOSITORY_ID",
      "Repository id must be a positive decimal integer.",
      400,
    );
  }
  const repositoryId = Number(rawRepositoryId);
  if (!Number.isSafeInteger(repositoryId)) {
    return errorResponse(
      "INVALID_REPOSITORY_ID",
      "Repository id must be a safe positive integer.",
      400,
    );
  }

  try {
    const config = loadConfig();
    const result = getStore(config.dataDir).enqueueRepository(
      repositoryId,
      new Date(),
    );
    if (!result.found) {
      return errorResponse(
        "REPOSITORY_NOT_FOUND",
        "Repository was not found.",
        404,
      );
    }
    return dataResponse({ accepted: result.accepted }, result.accepted ? 202 : 200);
  } catch (error) {
    return unexpectedErrorResponse(error);
  }
}
