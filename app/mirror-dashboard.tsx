"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";

import type {
  DashboardSnapshot,
  RepositoryStatus,
  RepositorySummary,
} from "../lib/contracts";

interface MirrorDashboardProps {
  organization: string;
  initialSnapshot: DashboardSnapshot;
}

interface DataEnvelope<T> {
  data: T;
}

const STATUS_LABELS: Record<RepositoryStatus, string> = {
  never_synced: "Never synced",
  queued: "Queued",
  syncing: "Synchronizing",
  healthy: "Healthy",
  failed: "Failed",
  unavailable: "Unavailable",
};

const SIZE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

function formatMirrorSize(sizeBytes: number | null): string {
  if (sizeBytes === null) {
    return "Not measured";
  }
  if (sizeBytes === 0) {
    return "0 B";
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(sizeBytes) / Math.log(1_024)),
    SIZE_UNITS.length - 1,
  );
  const value = sizeBytes / 1_024 ** unitIndex;
  return `${Math.round(value * 10) / 10} ${SIZE_UNITS[unitIndex]}`;
}

function snapshotsShareRepositories(
  current: DashboardSnapshot,
  next: DashboardSnapshot,
): boolean {
  return JSON.stringify(current.repositories) === JSON.stringify(next.repositories);
}

function Timestamp({ value }: { value: string | null }): React.ReactNode {
  if (!value) {
    return <span className="timestamp-empty">Not yet</span>;
  }

  return (
    <time dateTime={value} title={value}>
      <span suppressHydrationWarning>{new Date(value).toLocaleString()}</span>
      <span className="timestamp-exact">{value}</span>
    </time>
  );
}

const RepositoryRow = memo(function RepositoryRow({
  repository,
  isSubmitting,
  onSync,
}: {
  repository: RepositorySummary;
  isSubmitting: boolean;
  onSync: (repository: RepositorySummary) => Promise<void>;
}): React.ReactNode {
  const isActive =
    repository.status === "queued" || repository.status === "syncing";

  return (
    <article className="ledger-row" aria-label={repository.fullName}>
      <div className="repository-identity">
        <strong>{repository.name}</strong>
        <span>{repository.fullName}</span>
      </div>
      <div className="repository-status">
        <span className={`status status-${repository.status}`}>
          {STATUS_LABELS[repository.status]}
        </span>
      </div>
      <dl className="repository-times">
        <div>
          <dt>Last attempt</dt>
          <dd><Timestamp value={repository.lastAttemptAt} /></dd>
        </div>
        <div>
          <dt>Last success</dt>
          <dd><Timestamp value={repository.lastSuccessAt} /></dd>
        </div>
        <div>
          <dt>Mirror size</dt>
          <dd>{formatMirrorSize(repository.sizeBytes)}</dd>
        </div>
      </dl>
      <div className="repository-action">
        <button
          type="button"
          className="button button-secondary"
          disabled={isActive || isSubmitting}
          onClick={() => void onSync(repository)}
        >
          {isSubmitting ? "Queuing..." : isActive ? STATUS_LABELS[repository.status] : "Sync now"}
        </button>
      </div>
      {repository.latestError ? (
        <details className="repository-error">
          <summary>Latest error</summary>
          <p>{repository.latestError}</p>
        </details>
      ) : null}
    </article>
  );
});

/** Poll and operate the durable mirror ledger. */
export function MirrorDashboard({
  organization,
  initialSnapshot,
}: MirrorDashboardProps): React.ReactNode {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmittingAll, setIsSubmittingAll] = useState(false);
  const [submittingRepositories, setSubmittingRepositories] = useState(
    () => new Set<number>(),
  );

  const rows = useMemo(
    () =>
      [...snapshot.repositories].sort((left, right) =>
        left.fullName.localeCompare(right.fullName),
      ),
    [snapshot.repositories],
  );

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setIsRefreshing(true);
    try {
      const response = await fetch("/api/status", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        throw new Error(`Status refresh failed with HTTP ${response.status}.`);
      }
      const envelope = (await response.json()) as DataEnvelope<DashboardSnapshot>;
      setSnapshot((current) => ({
        ...envelope.data,
        repositories: snapshotsShareRepositories(current, envelope.data)
          ? current.repositories
          : envelope.data.repositories,
      }));
      setRefreshError(null);
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      setRefreshError(
        error instanceof Error ? error.message : "Status refresh failed.",
      );
    } finally {
      if (!signal?.aborted) {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timeout = window.setTimeout(poll, 2_000);

    async function poll(): Promise<void> {
      await refresh(controller.signal);
      if (!controller.signal.aborted) {
        timeout = window.setTimeout(poll, 2_000);
      }
    }

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [refresh]);

  const post = useCallback(
    async <T,>(url: string): Promise<T> => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json()) as
        | DataEnvelope<T>
        | { error: { message: string } };
      if (!response.ok || !("data" in payload)) {
        throw new Error(
          "error" in payload ? payload.error.message : `Request failed with HTTP ${response.status}.`,
        );
      }
      return payload.data;
    },
    [],
  );

  const handleSyncAll = useCallback(async (): Promise<void> => {
    setIsSubmittingAll(true);
    try {
      const result = await post<{ accepted: number; alreadyActive: number }>(
        "/api/sync",
      );
      setAnnouncement(
        `Sync all queued ${result.accepted} repositories; ${result.alreadyActive} already active.`,
      );
      await refresh();
    } catch (error) {
      setAnnouncement(
        error instanceof Error ? error.message : "Could not queue repositories.",
      );
    } finally {
      setIsSubmittingAll(false);
    }
  }, [post, refresh]);

  const handleSyncRepository = useCallback(
    async (repository: RepositorySummary): Promise<void> => {
      setSubmittingRepositories((current) =>
        new Set(current).add(repository.repositoryId),
      );
      try {
        const result = await post<{ accepted: boolean }>(
          `/api/repositories/${repository.repositoryId}/sync`,
        );
        setAnnouncement(
          result.accepted
            ? `${repository.fullName} was queued for synchronization.`
            : `${repository.fullName} is already queued or synchronizing.`,
        );
        await refresh();
      } catch (error) {
        setAnnouncement(
          error instanceof Error ? error.message : "Could not queue repository.",
        );
      } finally {
        setSubmittingRepositories((current) => {
          const next = new Set(current);
          next.delete(repository.repositoryId);
          return next;
        });
      }
    },
    [post, refresh],
  );

  return (
    <main className="console-shell">
      <header className="console-header">
        <div>
          <p className="product-name">MirrorMirror</p>
          <h1>Repository mirror ledger</h1>
          <p className="console-intro">
            Durable bare mirrors for <strong>{organization}</strong>.
          </p>
        </div>
        <button
          type="button"
          className="button button-primary"
          disabled={isSubmittingAll}
          onClick={() => void handleSyncAll()}
        >
          {isSubmittingAll ? "Queuing..." : "Sync all"}
        </button>
      </header>

      <section className="operations-strip" aria-label="Worker and schedule status">
        <div>
          <span>Worker</span>
          <strong className={`worker-${snapshot.worker.status}`}>
            {snapshot.worker.status === "online" ? "Online" : "Offline"}
          </strong>
        </div>
        <div>
          <span>Next scheduled cycle</span>
          <strong><Timestamp value={snapshot.scheduler.nextScheduledAt} /></strong>
        </div>
        <div>
          <span>Ledger refresh</span>
          <strong>{isRefreshing ? "Refreshing..." : "Current"}</strong>
        </div>
      </section>

      {snapshot.worker.status === "offline" ? (
        <p className="notice notice-warning" role="status">
          The worker heartbeat is stale or missing. New requests remain safely queued.
        </p>
      ) : null}
      {snapshot.scheduler.discoveryError ? (
        <p className="notice notice-error" role="alert">
          Repository discovery failed: {snapshot.scheduler.discoveryError}
        </p>
      ) : null}
      {refreshError ? (
        <p className="notice notice-error" role="status">
          Showing the last known ledger. {refreshError}
        </p>
      ) : null}
      <p
        className={announcement ? "action-result" : "sr-only"}
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>

      <section className="ledger" aria-labelledby="ledger-heading">
        <div className="ledger-heading">
          <div>
            <h2 id="ledger-heading">Mirrored repositories</h2>
            <p>{rows.length} tracked</p>
          </div>
          <span>All timestamps include exact UTC values.</span>
        </div>
        {rows.length === 0 ? (
          <p className="empty-state">
            No repositories are tracked yet. The worker will discover accessible repositories on its next cycle.
          </p>
        ) : (
          <div className="ledger-body">
            {rows.map((repository) => (
              <RepositoryRow
                key={repository.repositoryId}
                repository={repository}
                isSubmitting={submittingRepositories.has(repository.repositoryId)}
                onSync={handleSyncRepository}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
