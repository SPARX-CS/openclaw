// Memory Core tests cover manager source state plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectMemorySourceState,
  loadMemorySourceFileState,
  resolveMemorySourceFileEntries,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";

describe("memory source state", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    const insert = db.prepare(
      "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("memory/one.md", "memory", "hash-1", 100.25, 10);
    insert.run("memory/two.md", "memory", "hash-2", 200.5, 20);
    insert.run("memory/one.md", "sessions", "session-hash", 300.75, 30);
  });

  afterEach(() => db.close());

  it("loads complete indexed rows for the requested source", () => {
    expect(loadMemorySourceFileState({ db, source: "memory" })).toEqual([
      { path: "memory/one.md", hash: "hash-1", mtime: 100.25, size: 10 },
      { path: "memory/two.md", hash: "hash-2", mtime: 200.5, size: 20 },
    ]);
    db.prepare("DELETE FROM memory_index_sources WHERE source = ?").run("memory");
    expect(loadMemorySourceFileState({ db, source: "memory" })).toEqual([]);
  });

  it.each([
    { paths: [], expected: [] },
    { paths: ["memory/one.md", "memory/one.md", "missing' OR 1=1 --"], expected: ["hash-1"] },
    {
      paths: [...Array.from({ length: 33_000 }, (_, index) => `missing-${index}`), "memory/one.md"],
      expected: ["hash-1"],
    },
  ])("restricts source snapshots to $paths.length requested paths", ({ paths, expected }) => {
    expect(
      loadMemorySourceFileState({ db, source: "memory", paths }).map((row) => row.hash),
    ).toEqual(expected);
  });

  it.each([
    {
      existingHashes: new Map([["memory/one.md", "hash-from-snapshot"]]),
      expected: "hash-from-snapshot",
    },
    { existingHashes: new Map<string, string>(), expected: undefined },
  ])(
    "uses the bulk snapshot without consulting newer rows: $expected",
    ({ existingHashes, expected }) => {
      expect(
        resolveMemorySourceExistingHash({
          db,
          source: "memory",
          path: "memory/one.md",
          existingHashes,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    { source: "memory" as const, path: "memory/one.md", expected: "hash-1" },
    { source: "sessions" as const, path: "memory/one.md", expected: "session-hash" },
    { source: "sessions" as const, path: "memory/missing.md", expected: undefined },
  ])(
    "reads the current $source row for $path without a snapshot",
    ({ source, path: rowPath, expected }) => {
      expect(resolveMemorySourceExistingHash({ db, source, path: rowPath })).toBe(expected);
    },
  );
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("memory source inspection index watchdog", () => {
  let db: DatabaseSync;
  const settings = {
    extraPaths: [],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
  };

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
  });

  afterEach(() => db.close());

  it("reports a stale index when a memory file changed long ago is still unindexed", async () => {
    const workspaceDir = tempDirs.make("openclaw-memory-stale-");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    const notePath = path.join(workspaceDir, "memory", "2026-09-26.md");
    await fs.writeFile(notePath, "# Day\n- note\n");
    const changedAt = new Date("2026-09-26T08:00:00Z");
    await fs.utimes(notePath, changedAt, changedAt);
    const nowMs = changedAt.getTime() + 45 * 60_000;

    const stale = await inspectMemorySourceState({
      db,
      workspaceDir,
      settings,
      concurrency: 1,
      nowMs,
    });
    expect(stale.freshness).toMatchObject({ stale: true, stalePaths: ["memory/2026-09-26.md"] });
    expect(stale.issues).toEqual([
      expect.stringMatching(/^memory index stale: 1 memory file\(s\) changed more than 30 min ago/),
    ]);

    const [entry] = await resolveMemorySourceFileEntries({
      workspaceDir,
      settings,
      concurrency: 1,
    });
    db.prepare(
      "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run(entry!.path, "memory", entry!.hash, entry!.mtimeMs, entry!.size);
    const fresh = await inspectMemorySourceState({
      db,
      workspaceDir,
      settings,
      concurrency: 1,
      nowMs,
    });
    expect(fresh.freshness.stale).toBe(false);
    expect(fresh.issues).toEqual([]);
  });
});

describe("memory source inspection extra-path diagnostics", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
  });

  afterEach(() => db.close());

  it.skipIf(process.platform === "win32").each([true, false])(
    "reports skipped roots with canonical memory present: %s",
    async (canonicalMemory) => {
      const workspaceDir = tempDirs.make("openclaw-memory-source-");
      const vaultDir = tempDirs.make("openclaw-memory-vault-");
      await fs.mkdir(path.join(workspaceDir, "memory"));
      if (canonicalMemory) {
        await fs.writeFile(path.join(workspaceDir, "memory", "notes.md"), "# Canonical\n");
      }
      await fs.writeFile(path.join(vaultDir, "vault-note.md"), "# Vault\n");
      const linkedRoot = path.join(workspaceDir, "obsidian");
      await fs.symlink(vaultDir, linkedRoot, "dir");
      await fs.mkdir(path.join(workspaceDir, ".openclaw-repair"));
      await fs.symlink(vaultDir, path.join(workspaceDir, ".openclaw-repair", "root-memory"), "dir");

      const inspection = await inspectMemorySourceState({
        db,
        workspaceDir,
        settings: {
          extraPaths: [
            { path: "obsidian" },
            { path: "./obsidian", pattern: "*.md" },
            { path: ".openclaw-repair/root-memory" },
            { path: "missing" },
          ],
          multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
        },
        concurrency: 2,
      });

      expect(inspection.eligible).toBe(canonicalMemory ? 1 : 0);
      expect(inspection.issues).toEqual([
        ...(canonicalMemory ? [] : ["no eligible memory files found"]),
        expect.stringContaining('extra path "' + linkedRoot + '" is a symlink root'),
      ]);
      expect(inspection.issues.at(-1)).toContain("configure its canonical absolute directory");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps canonical extra roots eligible while skipping nested symlinks without a root warning",
    async () => {
      const workspaceDir = tempDirs.make("openclaw-memory-source-");
      const vaultDir = tempDirs.make("openclaw-memory-vault-");
      const nestedTarget = tempDirs.make("openclaw-memory-nested-");
      await fs.mkdir(path.join(workspaceDir, "memory"));
      await fs.writeFile(path.join(workspaceDir, "memory", "notes.md"), "# Canonical\n");
      await fs.writeFile(path.join(vaultDir, "vault-note.md"), "# Vault\n");
      await fs.writeFile(path.join(nestedTarget, "excluded.md"), "# Excluded\n");
      await fs.symlink(nestedTarget, path.join(vaultDir, "nested"), "dir");

      const inspection = await inspectMemorySourceState({
        db,
        workspaceDir,
        settings: {
          extraPaths: [{ path: vaultDir }],
          multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
        },
        concurrency: 2,
      });

      expect(inspection.eligible).toBe(2);
      expect(inspection.issues).toEqual([]);
    },
  );
});
