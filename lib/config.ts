import path from "node:path";

export interface RuntimeConfig {
  organization: string;
  token: string;
  dataDir: string;
  syncIntervalMs: number;
  gitOperationTimeoutMs: number;
}

const MINUTE_MS = 60 * 1000;
type Environment = Readonly<Record<string, string | undefined>>;

function requireText(
  env: Environment,
  field: "GITHUB_ORG" | "GITHUB_TOKEN",
): string {
  const value = env[field]?.trim();
  if (!value) {
    throw new Error(`Invalid ${field}: value is required.`);
  }

  return value;
}

function readPositiveMinutes(
  env: Environment,
  field: "SYNC_INTERVAL_MINUTES" | "GIT_OPERATION_TIMEOUT_MINUTES",
): number {
  const rawValue = env[field];
  if (rawValue === undefined) {
    return 60 * MINUTE_MS;
  }

  const value = rawValue.trim();
  const minutes = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(minutes) ||
    minutes <= 0 ||
    minutes > Number.MAX_SAFE_INTEGER / MINUTE_MS
  ) {
    throw new Error(`Invalid ${field}: expected a positive whole number.`);
  }

  return minutes * MINUTE_MS;
}

/** Load MirrorMirror runtime configuration. */
export function loadConfig(env: Environment = process.env): RuntimeConfig {
  return {
    organization: requireText(env, "GITHUB_ORG"),
    token: requireText(env, "GITHUB_TOKEN"),
    dataDir: path.resolve(
      /* turbopackIgnore: true */ env.MIRROR_DATA_DIR?.trim() || "./mirror-data",
    ),
    syncIntervalMs: readPositiveMinutes(env, "SYNC_INTERVAL_MINUTES"),
    gitOperationTimeoutMs: readPositiveMinutes(
      env,
      "GIT_OPERATION_TIMEOUT_MINUTES",
    ),
  };
}
