import {
  acceptsJson,
  dataResponse,
  errorResponse,
  unexpectedErrorResponse,
} from "../api-response";
import { loadConfig } from "../../../lib/config";
import { getStore } from "../../../lib/store";

export async function POST(request: Request): Promise<Response> {
  if (!acceptsJson(request)) {
    return errorResponse(
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
      415,
    );
  }

  try {
    const config = loadConfig();
    const result = getStore(config.dataDir).enqueueAllAvailable(new Date());
    return dataResponse(result, 202);
  } catch (error) {
    return unexpectedErrorResponse(error);
  }
}
