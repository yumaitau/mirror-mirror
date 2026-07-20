const MAX_ERROR_LENGTH = 2_000;
const REDACTED = "[REDACTED]";

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "Unexpected error.";
  }

  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "bigint" ||
    typeof error === "boolean"
  ) {
    return String(error);
  }

  return "Unexpected error.";
}

/** Convert an unknown failure into bounded, credential-free text. */
export function sanitizeError(
  error: unknown,
  secrets: readonly string[],
): string {
  let message = errorMessage(error);

  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }

    variants.add(secret);
    variants.add(encodeURIComponent(secret));
  }

  for (const secret of [...variants].sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, REDACTED);
  }

  message = message
    .replace(/\b(authorization\s*:\s*(?:bearer|token)\s+)\S+/gi, `$1${REDACTED}`)
    .replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, `$1${REDACTED}@`);

  if (message.length > MAX_ERROR_LENGTH) {
    return `${message.slice(0, MAX_ERROR_LENGTH - 3)}...`;
  }

  return message;
}
