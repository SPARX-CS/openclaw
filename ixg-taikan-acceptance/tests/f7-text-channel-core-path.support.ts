// Support for f7-text-channel-core-path.test.ts (works on tree A = 2026.9.6+patches and B = 2026.9.7).
//
// Real core path, fake model:
//   scripted fake LLM stream (streamSimple mock)
//     -> REAL agent session loop (src/agents/sessions) executing fake tools
//       -> REAL subscribeEmbeddedAgentSession handlers (tool start/end, projectAgentToolActivity, exec exit codes,
//          progress_card plan, compaction, finalizeToolActivity on B)
//         -> REAL createAgentRunEventHandler (src/auto-reply/reply/agent-runner-event-handler.ts) = params.onAgentEvent
//           -> the reply options handed to runReplyAgent (here: the reporter's callbacks)
//   and the REAL runReplyAgent decides the terminal outcome / final payloads (buildEmbeddedRunPayloads for the final).
// Only the embedded-runner entry (`runEmbeddedAgent`) is replaced (harness of agent-runner.misc.runreplyagent.test-support.ts).
//
// The test file MUST do this before importing this file:
//   await vi.hoisted(async () => {
//     await import("../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js");
//   });
import path from "node:path";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { vi } from "vitest";
import { buildEmbeddedRunPayloads } from "../../src/agents/embedded-agent-runner/run/payloads.js";
import { subscribeEmbeddedAgentSession } from "../../src/agents/embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  streamMocks,
} from "../../src/agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  rootDir,
  runEmbeddedAgentMock,
} from "../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js";
import {
  createTestQueueSettings,
  createTestQueuedFollowupRun,
  createTestTemplateContext,
} from "../../src/auto-reply/reply/agent-runner.test-fixtures.js";
import { createMockTypingController } from "../../src/auto-reply/reply/test-helpers.js";

const { runReplyAgent } = await import("../../src/auto-reply/reply/agent-runner.js");

export { runEmbeddedAgentMock };

type ToolCall = { id: string; name: string; args?: Record<string, unknown> };
/** `gate` holds the model's answer back (the model "thinks" with no tool signal) until the test releases it. */
export type Turn = ({ calls: ToolCall[] } | { text: string }) & { gate?: Promise<void> };

/** What a fake tool does when the loop executes it. `gate` blocks until the test releases it (fake time moves meanwhile). */
export type FakeToolBehavior = {
  gate?: Promise<void>;
  /** Throw this (a tool failure, like a real 401 / ENOENT). */
  throws?: Error;
  /** Tool result `details` (e.g. exec exitCode). */
  details?: Record<string, unknown>;
  text?: string;
};

export function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export type CapturedEvents = {
  toolStart: Array<Record<string, unknown>>;
  item: Array<Record<string, unknown>>;
  commandOutput: Array<Record<string, unknown>>;
  plan: Array<Record<string, unknown>>;
  approval: Array<Record<string, unknown>>;
  compactionStart: number;
  terminal: string[];
  runStart: number;
};

/**
 * Wraps reply options so every payload core hands over is recorded (deep-cloned) before the real callback runs.
 * This is the contract the reporter relies on, observed on the live path.
 */
export function captureReplyOptions<T extends Record<string, unknown>>(inner: T) {
  const cap: CapturedEvents = {
    toolStart: [],
    item: [],
    commandOutput: [],
    plan: [],
    approval: [],
    compactionStart: 0,
    terminal: [],
    runStart: 0,
  };
  const clone = (v: unknown) => structuredClone(v) as Record<string, unknown>;
  const wrap =
    (name: string, record: (p: never) => void) =>
    (...args: unknown[]) => {
      record(args[0] as never);
      return (inner[name] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
    };
  const opts = {
    ...inner,
    onToolStart: wrap("onToolStart", (p) => cap.toolStart.push(clone(p))),
    onItemEvent: wrap("onItemEvent", (p) => cap.item.push(clone(p))),
    onCommandOutput: wrap("onCommandOutput", (p) => cap.commandOutput.push(clone(p))),
    onPlanUpdate: wrap("onPlanUpdate", (p) => cap.plan.push(clone(p))),
    onApprovalEvent: wrap("onApprovalEvent", (p) => cap.approval.push(clone(p))),
    onCompactionStart: wrap("onCompactionStart", () => (cap.compactionStart += 1)),
    onAgentRunTerminalOutcome: wrap("onAgentRunTerminalOutcome", (p) =>
      cap.terminal.push(String(p)),
    ),
    onAgentRunStart: wrap("onAgentRunStart", () => (cap.runStart += 1)),
  } as T;
  return { opts, cap };
}

/**
 * Installs the scripted fake model + fake tools as the embedded runner for the next runReplyAgent call.
 * Returns what the real subscription saw (for assertions about the final payloads).
 */
export function installFakeEmbeddedRun(params: {
  turns: Turn[];
  tools: Record<string, FakeToolBehavior>;
  /** Make the embedded run itself fail after the scripted turns (provider outage etc.). */
  failAfter?: Error;
}) {
  const probe: {
    toolsStarted: string[];
    /** how many model requests the real session loop has made so far */
    modelCalls: number;
    finalPayloads?: ReturnType<typeof buildEmbeddedRunPayloads>;
    lastToolError?: unknown;
  } = { toolsStarted: [], modelCalls: 0 };
  runEmbeddedAgentMock.mockImplementationOnce(async (run: Record<string, unknown>) => {
    let turn = 0;
    streamMocks.streamSimple.mockImplementation((model: never) => {
      const t = params.turns[Math.min(turn, params.turns.length - 1)];
      turn += 1;
      probe.modelCalls += 1;
      const message =
        "text" in t
          ? createAssistant(model, [{ type: "text", text: t.text }])
          : createAssistant(
              model,
              t.calls.map((c) => ({
                type: "toolCall" as const,
                id: c.id,
                name: c.name,
                arguments: c.args ?? {},
              })),
              "toolUse",
            );
      if (!t.gate) {
        return createAssistantResultStream(message);
      }
      const stream = createAssistantMessageEventStream();
      void t.gate.then(() => {
        stream.push({ type: "done", reason: message.stopReason, message } as never);
        stream.end();
      });
      return stream;
    });
    const customTools = Object.entries(params.tools).map(([name, behavior]) => ({
      name,
      label: name,
      description: `fake ${name}`,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => {
        probe.toolsStarted.push(name);
        await behavior.gate;
        if (behavior.throws) {
          throw behavior.throws;
        }
        return {
          content: [{ type: "text" as const, text: behavior.text ?? "ok" }],
          details: behavior.details ?? {},
        };
      },
    }));
    // like production's runner: tell the reply layer the model call began (this is what fires onAgentRunStart)
    (run.onExecutionPhase as ((info: Record<string, unknown>) => void) | undefined)?.({
      phase: "model_call_started",
      provider: "anthropic",
      model: "claude",
    });
    const { session } = await createTestSession({ customTools: customTools as never });
    const sub = subscribeEmbeddedAgentSession({
      session,
      runId: String(run.runId),
      sessionKey: "main",
      verboseLevel: "off",
      // exactly what production wires: the reply layer's real event handler
      onAgentEvent: run.onAgentEvent as never,
    } as never);
    try {
      await session.prompt("please process the customer's request");
      await sub.waitForPendingEvents();
    } finally {
      sub.unsubscribe();
    }
    if (params.failAfter) {
      throw params.failAfter;
    }
    const lastAssistant = sub.getCurrentAttemptAssistant();
    probe.lastToolError = sub.getLastToolError();
    probe.finalPayloads = buildEmbeddedRunPayloads({
      assistantTexts: sub.assistantTexts,
      answerSegments: sub.answerSegments,
      lastAssistant,
      currentAssistant: lastAssistant ?? null,
      lastToolError: sub.getLastToolError(),
      sessionKey: "main",
      verboseLevel: "off",
    } as never);
    return {
      payloads: probe.finalPayloads,
      meta: { agentMeta: { provider: "anthropic", model: "claude" } },
    };
  });
  return probe;
}

/** One user request through the production reply layer (embedded provider), with the given reply options. */
export function createEmbeddedRun(opts: Record<string, unknown>) {
  const typing = createMockTypingController();
  const sessionCtx = createTestTemplateContext({ Provider: "telegram", MessageSid: "msg" });
  const followupRun = createTestQueuedFollowupRun({
    prompt: "please process the customer's request",
    summaryLine: "please process the customer's request",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "telegram",
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text"] }],
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 600_000,
      blockReplyBreak: "message_end",
    },
  });
  const params = {
    commandBody: "please process the customer's request",
    followupRun,
    queueKey: "main",
    resolvedQueue: createTestQueueSettings({ mode: "interrupt" }),
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing,
    sessionCtx,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    opts,
  } as unknown as Parameters<typeof runReplyAgent>[0];
  return { run: () => runReplyAgent(params) };
}

export function payloadTexts(result: unknown): string[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list
    .map((p) => (p as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string");
}

/** Real macrotask turns (setImmediate is not faked) so the session loop / subscribe chain can progress between fake-time steps. */
export async function settle(turns = 20) {
  for (let i = 0; i < turns; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Waits (real turns, fake clock untouched) until `cond()` holds. */
export async function until(cond: () => boolean, label: string, maxTurns = 400) {
  for (let i = 0; i < maxTurns; i += 1) {
    if (cond()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

export { createMockTypingController };
