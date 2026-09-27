import { describe, expect, it } from "vitest";
import {
  evaluateMemoryIndexFreshness,
  formatMemoryIndexStaleIssue,
  MEMORY_INDEX_STALE_THRESHOLD_MS,
} from "./memory-index-freshness.js";

const NOW = 10_000_000_000;
const MIN = 60_000;

describe("memory index freshness watchdog", () => {
  it("is fresh when every file matches its indexed hash", () => {
    const freshness = evaluateMemoryIndexFreshness({
      files: [{ path: "MEMORY.md", hash: "a", mtimeMs: NOW - 120 * MIN }],
      indexed: [{ path: "MEMORY.md", hash: "a" }],
      nowMs: NOW,
    });
    expect(freshness).toEqual({
      stale: false,
      thresholdMs: MEMORY_INDEX_STALE_THRESHOLD_MS,
      pendingFiles: 0,
      stalePaths: [],
    });
    expect(formatMemoryIndexStaleIssue(freshness)).toBeUndefined();
  });

  it("tolerates recent unindexed changes within the threshold", () => {
    const freshness = evaluateMemoryIndexFreshness({
      files: [{ path: "memory/2026-09-26.md", hash: "new", mtimeMs: NOW - 5 * MIN }],
      indexed: [{ path: "memory/2026-09-26.md", hash: "old" }],
      nowMs: NOW,
    });
    expect(freshness).toMatchObject({ stale: false, pendingFiles: 1, oldestPendingAgeMs: 5 * MIN });
  });

  it("reports stale when changed or new files stay unindexed past the threshold", () => {
    const freshness = evaluateMemoryIndexFreshness({
      files: [
        { path: "memory/b.md", hash: "new", mtimeMs: NOW - 45 * MIN },
        { path: "memory/a.md", hash: "x", mtimeMs: NOW - 90 * MIN },
        { path: "MEMORY.md", hash: "same", mtimeMs: NOW - 500 * MIN },
      ],
      indexed: [
        { path: "memory/b.md", hash: "old" },
        { path: "MEMORY.md", hash: "same" },
      ],
      nowMs: NOW,
    });
    expect(freshness).toEqual({
      stale: true,
      thresholdMs: 30 * MIN,
      pendingFiles: 2,
      stalePaths: ["memory/a.md", "memory/b.md"],
      oldestPendingAgeMs: 90 * MIN,
    });
    expect(formatMemoryIndexStaleIssue(freshness)).toBe(
      "memory index stale: 2 memory file(s) changed more than 30 min ago are not reflected in the index " +
        "(oldest change 90 min ago: memory/a.md, memory/b.md); run `openclaw memory index` and check the gateway logs for sync errors",
    );
  });
});
