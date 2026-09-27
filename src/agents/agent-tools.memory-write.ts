// Memory-file write observer for agent coding tools: provenance plus the source-support gate.
import { renderMemoryWriteSourceMessages } from "../memory/memory-write-gate.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";

export function createAgentMemoryWriteObserver(params: {
  options?: OpenClawCodingToolsOptions;
  root: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
}) {
  const bridge = params.sandboxFsBridge;
  return createMemoryWriteProvenanceObserver({
    mutationRoot: params.root,
    workspaceDir: params.root,
    resolvePath: bridge
      ? (filePath) =>
          resolveSandboxFileIdentity({
            bridge,
            filePath,
            cwd: params.sandboxRoot,
            signal: params.options?.abortSignal,
          })
      : undefined,
    resolveOriginClass: () =>
      params.options?.senderIsOwner === false || params.options?.isTurnTainted?.() === true
        ? "untrusted"
        : "agent",
    sessionId: params.options?.sessionId,
    sessionKey: params.options?.runSessionKey ?? params.options?.sessionKey,
    // Memory files (MEMORY.md, memory/*.md, USER.md) only accept lines the
    // current session transcript supports; see src/memory/memory-write-gate.ts.
    writeGate: {
      requireRefKind: "session-transcript",
      resolveSources: () => {
        const sessionId = params.options?.sessionId;
        const messages = params.options?.resolveMemoryWriteSourceMessages?.();
        if (!sessionId || !messages) {
          return [];
        }
        return [
          {
            ref: { kind: "session-transcript", sessionId, messageCount: messages.length },
            text: renderMemoryWriteSourceMessages(messages),
          },
        ];
      },
    },
  });
}
