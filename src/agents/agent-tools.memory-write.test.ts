// Memory-file writes through the coding tools: provenance and the source-support gate.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createContainerWorkspaceSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

type OpenClawCodingTool = ReturnType<typeof createOpenClawCodingTools>[number];
function requireTool(tools: OpenClawCodingTool[], name: string): OpenClawCodingTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`expected ${name} tool`);
  }
  return tool;
}

function requireToolExecute(tool: OpenClawCodingTool): NonNullable<OpenClawCodingTool["execute"]> {
  if (!tool.execute) {
    throw new Error(`expected ${tool.name} tool execute`);
  }
  return tool.execute;
}

// Memory-file writes must be supported by the run transcript (memory write gate).
function memoryWriteTranscript(sessionId: string, ...userTexts: string[]) {
  return {
    sessionId,
    resolveMemoryWriteSourceMessages: () => userTexts.map((content) => ({ role: "user", content })),
  };
}

describe("createOpenClawCodingTools memory writes", () => {
  it("records restricted memory flush writes without an active memory provider", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-workspace-"));
    const taskCwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-cwd-"));
    const memoryRelativePath = "memory/2026-03-24.md";
    const workspaceMemoryFile = path.join(workspaceDir, memoryRelativePath);
    const taskMemoryFile = path.join(taskCwd, memoryRelativePath);

    try {
      await fs.mkdir(path.dirname(workspaceMemoryFile), { recursive: true });
      await fs.writeFile(workspaceMemoryFile, "seed", "utf8");

      const tools = createOpenClawCodingTools({
        workspaceDir,
        cwd: taskCwd,
        config: { plugins: { slots: { memory: "none" } } },
        trigger: "memory",
        memoryFlushWritePath: memoryRelativePath,
        senderIsOwner: false,
        ...memoryWriteTranscript("flush-session", "Store durable notes now."),
      });
      const writeExecute = requireToolExecute(requireTool(tools, "write"));

      await writeExecute("tool-memory-flush-workspace", {
        path: memoryRelativePath,
        content: "new durable note",
      });

      await expect(fs.readFile(workspaceMemoryFile, "utf8")).resolves.toBe(
        "seed\nnew durable note",
      );
      await expect(fs.stat(taskMemoryFile)).rejects.toThrow();
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: memoryRelativePath }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(taskCwd, { recursive: true, force: true });
    }
  });

  it("records turn taint and source-session lineage for memory writes, edits, and patches", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-write-taint-"));
    let tainted = false;
    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        config: { tools: { fs: { workspaceOnly: true } } },
        ...memoryWriteTranscript("source-session", "Please keep a note."),
        sessionKey: "agent:main:policy-session",
        runSessionKey: "agent:main:durable-session",
        senderIsOwner: true,
        isTurnTainted: () => tainted,
      });
      const write = requireToolExecute(requireTool(tools, "write"));
      const edit = requireToolExecute(requireTool(tools, "edit"));
      const applyPatch = requireToolExecute(requireTool(tools, "apply_patch"));

      await write("write-memory", {
        path: "memory/2026-07-29.md",
        content: "owner-requested note\n",
      });
      tainted = true;
      await edit("edit-memory", {
        path: "memory/2026-07-29.md",
        edits: [{ oldText: "note", newText: "network-derived note" }],
      });
      await applyPatch("patch-memory", {
        input: [
          "*** Begin Patch",
          "*** Add File: memory/project.md",
          "+network project note",
          "*** End Patch",
        ].join("\n"),
      });

      await expect(
        Promise.all(
          ["memory/2026-07-29.md", "memory/project.md"].map((relativePath) =>
            readMemoryArtifactProvenance({ workspaceDir, relativePath }),
          ),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          originClass: "untrusted",
          sessionId: "source-session",
          sessionKey: "agent:main:durable-session",
        }),
        expect.objectContaining({
          originClass: "untrusted",
          sessionId: "source-session",
          sessionKey: "agent:main:durable-session",
        }),
      ]);
      await expect(
        applyPatch("patch-existing-memory", {
          input: [
            "*** Begin Patch",
            "*** Add File: memory/project.md",
            "+replacement",
            "*** End Patch",
          ].join("\n"),
        }),
      ).rejects.toThrow(/file already exists/i);
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/project.md" }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
      await expect(fs.readFile(path.join(workspaceDir, "memory/project.md"), "utf8")).resolves.toBe(
        "network project note\n",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("records agent provenance after an untainted same-turn delete and recreate", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-recreate-"));
    try {
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory/recreated.md"), "old\n", "utf8");
      const applyPatch = requireToolExecute(
        requireTool(
          createOpenClawCodingTools({
            workspaceDir,
            senderIsOwner: true,
            isTurnTainted: () => false,
            ...memoryWriteTranscript("recreate-session", "Recreate the note."),
          }),
          "apply_patch",
        ),
      );
      await applyPatch("delete-memory", {
        input: "*** Begin Patch\n*** Delete File: memory/recreated.md\n*** End Patch",
      });
      await applyPatch("recreate-memory", {
        input: "*** Begin Patch\n*** Add File: memory/recreated.md\n+recreated\n*** End Patch",
      });
      await expect(
        readMemoryArtifactProvenance({
          workspaceDir,
          relativePath: "memory/recreated.md",
        }),
      ).resolves.toMatchObject({ originClass: "agent" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("gates agent memory writes against the run transcript before anything lands", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-gate-"));
    const memoryFile = path.join(workspaceDir, "MEMORY.md");
    try {
      await fs.writeFile(memoryFile, "# Memory\n", "utf8");
      const tools = createOpenClawCodingTools({
        workspaceDir,
        senderIsOwner: true,
        ...memoryWriteTranscript(
          "gate-session",
          "The renewal quote for Northwind is $1,200 and is due 2026-10-01.",
        ),
      });
      const write = requireToolExecute(requireTool(tools, "write"));
      const edit = requireToolExecute(requireTool(tools, "edit"));

      await expect(
        write("gate-changed-number", {
          path: "MEMORY.md",
          content: "# Memory\n- Northwind renewal quote: $1,500, due 2026-10-01\n",
        }),
      ).rejects.toThrow(/line 2: contains values not present in the source \(amount "USD 1500"\)/);
      await expect(
        edit("gate-invented-name", {
          path: "MEMORY.md",
          edits: [
            { oldText: "# Memory\n", newText: "# Memory\n- Contact at Northwind is Alvarez\n" },
          ],
        }),
      ).rejects.toThrow(
        /names a person\/entity not present in the source \(proper-noun "Alvarez"\)/,
      );
      await expect(fs.readFile(memoryFile, "utf8")).resolves.toBe("# Memory\n");
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: "MEMORY.md" }),
      ).resolves.toBeUndefined();

      await write("gate-supported", {
        path: "MEMORY.md",
        content: "# Memory\n- Northwind renewal quote: $1,200, due 2026-10-01\n",
      });
      await expect(fs.readFile(memoryFile, "utf8")).resolves.toContain("$1,200");
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: "MEMORY.md" }),
      ).resolves.toMatchObject({
        sessionId: "gate-session",
        verification: {
          gate: "lexical-v1",
          checkedLines: 1,
          sourceRefs: [{ kind: "session-transcript", sessionId: "gate-session", messageCount: 1 }],
        },
      });

      const unsourced = createOpenClawCodingTools({ workspaceDir, senderIsOwner: true });
      await expect(
        requireToolExecute(requireTool(unsourced, "write"))("gate-no-source", {
          path: "memory/notes.md",
          content: "- plain note\n",
        }),
      ).rejects.toThrow(/no resolvable source reference/);
      await expect(fs.stat(path.join(workspaceDir, "memory/notes.md"))).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("gates memory flush appends and leaves the daily file untouched on rejection", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-flush-gate-"));
    const memoryRelativePath = "memory/2026-09-26.md";
    const memoryFile = path.join(workspaceDir, memoryRelativePath);
    try {
      await fs.mkdir(path.dirname(memoryFile), { recursive: true });
      await fs.writeFile(memoryFile, "seed\n", "utf8");
      const write = requireToolExecute(
        requireTool(
          createOpenClawCodingTools({
            workspaceDir,
            trigger: "memory",
            memoryFlushWritePath: memoryRelativePath,
            senderIsOwner: true,
            ...memoryWriteTranscript(
              "flush-gate-session",
              "田中さんとの打ち合わせは3月5日に決まりました。",
              "Store durable memories now.",
            ),
          }),
          "write",
        ),
      );

      await expect(
        write("flush-invented-name", {
          path: memoryRelativePath,
          content: "- 佐藤様との打ち合わせは3月5日",
        }),
      ).rejects.toThrow(/cjk-name "佐藤"/);
      await expect(fs.readFile(memoryFile, "utf8")).resolves.toBe("seed\n");

      await write("flush-supported", {
        path: memoryRelativePath,
        content: "- 田中さんとの打ち合わせは3月5日",
      });
      await expect(fs.readFile(memoryFile, "utf8")).resolves.toBe(
        "seed\n- 田中さんとの打ち合わせは3月5日",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.each(["relative", "container"])(
    "records sandbox-backed %s memory writes before mutation",
    async (pathKind) => {
      const workspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-memory-sandbox-taint-"),
      );
      const sandboxRoot = path.join(workspaceDir, "private");
      await fs.mkdir(sandboxRoot);
      try {
        const sandbox = createAgentToolsSandboxContext({
          workspaceDir: sandboxRoot,
          agentWorkspaceDir: workspaceDir,
          fsBridge: createContainerWorkspaceSandboxFsBridge(sandboxRoot),
          workspaceAccess: "none",
        });
        const tools = createOpenClawCodingTools({
          workspaceDir,
          sandbox,
          senderIsOwner: true,
          isTurnTainted: () => true,
          ...memoryWriteTranscript("sandbox-session", "Save a project note."),
        });
        const filePath = (relative: string) =>
          pathKind === "container" ? `/workspace/${relative}` : relative;
        await requireToolExecute(requireTool(tools, "write"))("sandbox-project", {
          path: filePath("project.txt"),
          content: "before\n",
        });
        await requireToolExecute(requireTool(tools, "edit"))("sandbox-edit", {
          path: filePath("project.txt"),
          edits: [{ oldText: "before", newText: "after" }],
        });
        await expect(fs.readFile(path.join(sandboxRoot, "project.txt"), "utf8")).resolves.toBe(
          "after\n",
        );
        await requireToolExecute(requireTool(tools, "write"))("sandbox-memory", {
          path: filePath("memory/2026-07-29.md"),
          content: "sandbox network note\n",
        });
        await requireToolExecute(requireTool(tools, "apply_patch"))("sandbox-patch", {
          input: `*** Begin Patch\n*** Add File: ${filePath("memory/nested/project.md")}\n+project note\n*** End Patch`,
        });
        await expect(
          readMemoryArtifactProvenance({
            workspaceDir: sandboxRoot,
            relativePath: "memory/nested/project.md",
          }),
        ).resolves.toMatchObject({ originClass: "untrusted" });

        await expect(
          readMemoryArtifactProvenance({
            workspaceDir: sandboxRoot,
            relativePath: "memory/2026-07-29.md",
          }),
        ).resolves.toMatchObject({ originClass: "untrusted" });
        await expect(
          readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/2026-07-29.md" }),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );
});
