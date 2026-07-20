import { sanitizeError } from "../../lib/errors";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export function dataResponse(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: NO_STORE_HEADERS });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: NO_STORE_HEADERS },
  );
}

export function unexpectedErrorResponse(error: unknown): Response {
  console.error(
    "MirrorMirror API failure:",
    sanitizeError(error, [process.env.GITHUB_TOKEN ?? ""]),
  );
  return errorResponse(
    "INTERNAL_ERROR",
    "An unexpected server error occurred.",
    500,
  );
}

export function acceptsJson(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
