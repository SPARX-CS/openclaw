/**
 * Memory index watchdog: detects an index that stopped following memory files.
 *
 * A memory file is "pending" when its current content hash differs from the
 * indexed row (or it has no row). Pending is normal for a short while after a
 * write; it is "stale" once the file's last modification is older than the
 * threshold and the index still has not caught up.
 */
export const MEMORY_INDEX_STALE_THRESHOLD_MS = 30 * 60 * 1000;

export type MemoryIndexFreshness = {
  stale: boolean;
  thresholdMs: number;
  /** Files whose current content is not reflected in the index. */
  pendingFiles: number;
  /** Pending files whose change is older than the threshold. */
  stalePaths: string[];
  /** Age of the oldest change the index has not picked up. */
  oldestPendingAgeMs?: number;
};

export function evaluateMemoryIndexFreshness(params: {
  files: ReadonlyArray<{ path: string; hash: string; mtimeMs: number }>;
  indexed: ReadonlyArray<{ path: string; hash: string }>;
  nowMs: number;
  thresholdMs?: number;
}): MemoryIndexFreshness {
  const thresholdMs = params.thresholdMs ?? MEMORY_INDEX_STALE_THRESHOLD_MS;
  const indexedHashes = new Map(params.indexed.map((row) => [row.path, row.hash]));
  let pendingFiles = 0;
  let oldestPendingAgeMs: number | undefined;
  const stalePaths: string[] = [];
  for (const file of params.files) {
    if (indexedHashes.get(file.path) === file.hash) {
      continue;
    }
    pendingFiles += 1;
    const ageMs = Math.max(0, params.nowMs - file.mtimeMs);
    oldestPendingAgeMs = Math.max(oldestPendingAgeMs ?? 0, ageMs);
    if (ageMs > thresholdMs) {
      stalePaths.push(file.path);
    }
  }
  return {
    stale: stalePaths.length > 0,
    thresholdMs,
    pendingFiles,
    stalePaths: stalePaths.toSorted(),
    ...(oldestPendingAgeMs !== undefined ? { oldestPendingAgeMs } : {}),
  };
}

export function formatMemoryIndexStaleIssue(freshness: MemoryIndexFreshness): string | undefined {
  if (!freshness.stale) {
    return undefined;
  }
  const minutes = (ms: number) => Math.floor(ms / 60_000);
  const sample = freshness.stalePaths.slice(0, 3).join(", ");
  const more = freshness.stalePaths.length > 3 ? ` (+${freshness.stalePaths.length - 3} more)` : "";
  return (
    `memory index stale: ${freshness.stalePaths.length} memory file(s) changed more than ` +
    `${minutes(freshness.thresholdMs)} min ago are not reflected in the index ` +
    `(oldest change ${minutes(freshness.oldestPendingAgeMs ?? 0)} min ago: ${sample}${more}); ` +
    "run `openclaw memory index` and check the gateway logs for sync errors"
  );
}
