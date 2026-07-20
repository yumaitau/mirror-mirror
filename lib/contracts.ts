export type SyncState =
  | "never_synced"
  | "queued"
  | "syncing"
  | "healthy"
  | "failed";

export type RepositoryStatus = SyncState | "unavailable";

export interface DiscoveredRepository {
  githubId: number;
  name: string;
  fullName: string;
  cloneUrl: string;
}

export interface RepositorySummary {
  repositoryId: number;
  name: string;
  fullName: string;
  status: RepositoryStatus;
  sizeBytes: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  latestError: string | null;
}

export interface DashboardSnapshot {
  repositories: RepositorySummary[];
  scheduler: {
    nextScheduledAt: string | null;
    discoveryError: string | null;
  };
  worker: {
    status: "online" | "offline";
    lastHeartbeatAt: string | null;
  };
}

export interface StoreHealth {
  activeCycleId: number | null;
  nextScheduledAt: string | null;
  workerHeartbeatAt: string | null;
}

export interface SyncJob {
  repositoryId: number;
  fullName: string;
  cloneUrl: string;
  mirrorPath: string;
}

export type SyncOutcome =
  | { success: true; sizeBytes: number }
  | { success: false; error: string };
