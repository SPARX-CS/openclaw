// Scenario replay of a completion hand-off runaway on one 1:1 DM session: the requester's
// reply ended, then image and subagent completions kept waking it with no active run.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { resolveVisibleRepliesPolicy } from "../../../auto-reply/reply/dispatch-from-config.harness-defaults.js";
import { resolveStableMessageToolAvailability } from "../../../auto-reply/reply/session-stable-reply-mode.js";
import { resolveSourceReplyVisibilityPolicy } from "../../../auto-reply/reply/source-reply-delivery-mode.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { errorShapeFromError } from "../../../gateway/error-shape.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import type { AgentRunRequest } from "../../../gateway/server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { drainPendingSessionDelivery } from "../../../infra/session-delivery-queue-recovery.js";
import { loadPendingSessionDeliveries } from "../../../infra/session-delivery-queue-storage.js";
import type { QueuedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { createSuiteTempRootTracker } from "../../../test-helpers/temp-dir.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
import { agentCommandFromIngress } from "../../agent-command.js";
import { buildDefaultTestCliBackend } from "../../cli-runner.test-helpers.js";
import type { PreparedCliRunContext } from "../../cli-runner/types.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../../command/claude-cli-project-dir.js";
import { FailoverError, isFailoverError } from "../../failover-error.js";
import { imageGenerationTaskLifecycle } from "../../tools/media-generate-background.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

const configIo = vi.hoisted(() => ({ cfg: {} as unknown }));
// Config file IO: the scenario owns one in-memory config.
vi.mock("../../../config/io.js", () => ({
  getRuntimeConfig: () => configIo.cfg,
  loadConfig: () => configIo.cfg,
  readConfigFileSnapshotForWrite: async () => {
    throw new Error("scenario has no config file");
  },
}));

const cliProcess = vi.hoisted(() => ({ execute: vi.fn() }));
// Bypassed boundary: the claude-cli subprocess (spawn, stdio, native transcript writes).
vi.mock("../../cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: cliProcess.execute,
}));

const gatewayTurn = vi.hoisted(() => ({ startTurn: vi.fn() }));
// Bypassed boundary: Gateway request authorization/envelope around the in-process facade.
vi.mock("../../../gateway/server-methods.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
  createRequestGatewayMethodRegistry: () => ({ isControlPlaneWrite: () => false }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));
// Bypassed boundary: Gateway agent preflight and turn service (admission queue, dedupe,
// session persist, delivery phase); the scenario's startTurn keeps acceptance/final framing.
vi.mock("../../../gateway/agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));
vi.mock("../../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn: gatewayTurn.startTurn, waitForTurn: vi.fn() }),
}));

const SESSION_KEY = "agent:main:discord:direct:requester";
const REQUESTER_SESSION_ID = "requester-session";
const MAIN_CLI_SESSION_ID = "0f5c2a9e-6f1b-4c3d-9a8e-1b2c3d4e5f60";
const PRIMARY_MODEL = "anthropic/claude-opus-4-6";
const FALLBACK_MODEL = "anthropic/claude-sonnet-4-6";
const ANNOUNCE_TIMEOUT_MS = 30_000;
const DM_ORIGIN = { channel: "discord", to: "user:requester", accountId: "default" };

type CliExecution = {
  runId: string;
  model: string;
  resumeSessionId: string | undefined;
  reuse: PreparedCliRunContext["reusableCliSession"];
  messageToolPolicyHash: string | undefined;
};

type HandoffTurn = {
  idempotencyKey: string;
  outcome: "pending" | "ok" | "error" | "cancelled";
  error?: unknown;
};

const fixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-handoff-runaway-" });
const cliExecutions: CliExecution[] = [];
const handoffTurns: HandoffTurn[] = [];
const admissionHolds = new Map<string, { reached: () => void; admitted: Promise<void> }>();
const gatewayTurnsSettled = new Map<string, Promise<void>>();
const billingExhaustedRunIds = new Set<string>();
const channelSends: string[] = [];
let suiteRoot = "";
let storePath = "";
let workspaceDir = "";
let envSnapshot: ReturnType<typeof captureEnv> | undefined;
let userTurnPolicyHash: string | undefined;

function readRequesterEntry(): SessionEntry | undefined {
  return loadSessionEntryReadOnly({
    agentId: "main",
    sessionKey: SESSION_KEY,
    storePath,
    readConsistency: "latest",
  });
}

function turnsFor(idempotencyKey: string) {
  return handoffTurns.filter((turn) => turn.idempotencyKey === idempotencyKey);
}

function executionsFor(runIdPrefix: string) {
  return cliExecutions.filter((execution) => execution.runId.startsWith(runIdPrefix));
}

function createGatewayContext() {
  return Object.assign({} as GatewayRequestContext, {
    trackExecution: <T>(run: () => Promise<T>) => run(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    chatAbortControllers: new Map(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    getRuntimeConfig: () => configIo.cfg,
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  });
}

const gatewayContext = createGatewayContext();
const facade = createInternalAgentTurnFacade({
  client: createSyntheticPluginRuntimeClient(),
  getContext: () => gatewayContext,
});
const commandRuntime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
// Mirrors the Gateway agent handler's acceptance/final framing around the real agent command.
gatewayTurn.startTurn.mockImplementation(
  async ({
    preflight,
    io,
  }: {
    preflight: { request: AgentRunRequest };
    io: {
      emitAcceptance: (frame: [boolean, unknown, unknown], meta?: Record<string, unknown>) => void;
      emitExecutionStarted?: () => void;
      emitFinal: (frame: [boolean, unknown, unknown], meta?: Record<string, unknown>) => void;
    };
  }) => {
    const request = preflight.request;
    const runId = request.idempotencyKey;
    const settled = createDeferredCore();
    gatewayTurnsSettled.set(runId, settled.promise);
    try {
      // A held key models a busy requester lane: acceptance waits for admission.
      const hold = admissionHolds.get(runId);
      hold?.reached();
      await hold?.admitted;
      await runGatewayTurn(request, runId, io);
    } finally {
      settled.resolve();
    }
  },
);

async function runGatewayTurn(
  request: AgentRunRequest,
  runId: string,
  io: {
    emitAcceptance: (frame: [boolean, unknown, unknown], meta?: Record<string, unknown>) => void;
    emitExecutionStarted?: () => void;
    emitFinal: (frame: [boolean, unknown, unknown], meta?: Record<string, unknown>) => void;
  },
) {
  const registration = registerChatAbortController({
    chatAbortControllers: gatewayContext.chatAbortControllers,
    runId,
    sessionId: readRequesterEntry()?.sessionId ?? REQUESTER_SESSION_ID,
    sessionKey: request.sessionKey,
    timeoutMs: 600_000,
    kind: "agent",
  });
  const turn: HandoffTurn = { idempotencyKey: runId, outcome: "pending" };
  handoffTurns.push(turn);
  io.emitAcceptance([true, { runId, status: "accepted" }, undefined], { runId });
  try {
    const result = await withPluginRuntimeGatewayRequestScope(
      { pluginRegistry, isWebchatConnect: () => false } as never,
      async () => {
        return await agentCommandFromIngress(
          {
            message: request.message,
            sessionKey: request.sessionKey,
            deliver: request.deliver,
            bestEffortDeliver: request.bestEffortDeliver,
            channel: request.channel,
            to: request.to,
            accountId: request.accountId,
            threadId: request.threadId,
            runId,
            internalEvents: request.internalEvents,
            inputProvenance: request.inputProvenance,
            sourceReplyDeliveryMode: request.sourceReplyDeliveryMode,
            disableMessageTool: request.disableMessageTool,
            forceRestartSafeTools: request.forceRestartSafeTools,
            allowModelOverride: false,
            abortSignal: registration.controller.signal,
            onExecutionStarted: () => io.emitExecutionStarted?.(),
          } as never,
          commandRuntime as never,
        );
      },
    );
    turn.outcome = "ok";
    io.emitFinal([true, { runId, status: "ok", result }, undefined], { runId });
  } catch (cause) {
    turn.outcome = registration.controller.signal.aborted ? "cancelled" : "error";
    turn.error = cause;
    const error = errorShapeFromError(ErrorCodes.UNAVAILABLE, cause);
    Object.defineProperty(error, "cause", { value: cause });
    io.emitFinal([false, { runId, status: "error" }, error], { runId });
  } finally {
    gatewayContext.chatAbortControllers.delete(runId);
  }
}

// In-process Gateway transport: same option projection as dispatchGatewayMethodInProcess.
function dispatchAgentInProcess(
  _method: string,
  params: Record<string, unknown>,
  options?: Record<string, unknown>,
) {
  return facade.dispatch(params as AgentRunRequest, {
    cancelOnDeadline: options?.cancelOnDeadline as boolean | undefined,
    expectFinal: options?.expectFinal as boolean | undefined,
    onAccepted: options?.onAccepted as ((payload: unknown) => void) | undefined,
    onExecutionStarted: options?.onExecutionStarted as (() => void) | undefined,
    signal: options?.signal as AbortSignal | undefined,
    timeoutMs: options?.timeoutMs as number | undefined,
  });
}

// claude-cli process double: resumes what prepare selected and reports the message-tool send.
cliProcess.execute.mockImplementation(
  async (context: PreparedCliRunContext, cliSessionIdToUse?: string) => {
    const runId = context.params.runId;
    cliExecutions.push({
      runId,
      model: context.modelId,
      resumeSessionId: cliSessionIdToUse,
      reuse: context.reusableCliSession,
      messageToolPolicyHash: context.messageToolPolicyHash,
    });
    if ([...billingExhaustedRunIds].some((key) => runId.startsWith(key))) {
      throw new FailoverError("You have reached your usage limit.", {
        reason: "billing",
        provider: "claude-cli",
        model: context.modelId,
        status: 402,
      });
    }
    // A fresh (non-resumed) claude session gets its own native id and transcript.
    const sessionId =
      cliSessionIdToUse ??
      (runId === "user-turn"
        ? MAIN_CLI_SESSION_ID
        : `0f5c2a9e-6f1b-4c3d-9a8e-${String(cliExecutions.length).padStart(12, "0")}`);
    writeNativeClaudeTranscript(sessionId);
    const text = "Here is your picture.";
    return {
      text,
      sessionId,
      ...(context.params.sourceReplyDeliveryMode === "message_tool_only"
        ? {
            didSendViaMessagingTool: true,
            didDeliverSourceReplyViaMessageTool: true,
            messagingToolSentTexts: [text],
            messagingToolSentTargets: [
              { tool: "message", provider: "discord", to: DM_ORIGIN.to, accountId: "default" },
            ],
          }
        : {}),
    };
  },
);

// The shared test setup resets the plugin runtime after each test, so every stage
// publishes a fresh registry holding the Discord channel and the claude-cli backend.
let pluginRegistry = createEmptyPluginRegistry();

function installScenarioPluginRegistry() {
  pluginRegistry = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: createOutboundTestPlugin({
        id: "discord",
        outbound: {
          ...createDirectOutboundTestAdapter({ channel: "discord" }),
          // Bypassed boundary: the Discord platform send.
          sendText: async ({ text }: { text: string }) => {
            channelSends.push(text);
            return { channel: "discord", messageId: `msg-${channelSends.length}` };
          },
        },
      }),
    },
  ]);
  // Bypassed boundary: the anthropic plugin's claude-cli backend. This double keeps the
  // reuse-relevant fields of that definition (always-resend system prompt, raw reseed).
  const base = buildDefaultTestCliBackend();
  const backend = {
    ...base,
    id: "claude-cli",
    config: {
      ...base.config,
      command: "claude",
      sessionMode: "always" as const,
      systemPromptArg: undefined,
      systemPromptFileArg: "--append-system-prompt-file",
      systemPromptWhen: "always" as const,
      reseedFromRawTranscriptWhenUncompacted: true,
    },
  };
  pluginRegistry.cliBackends.push({ pluginId: backend.pluginId, backend, source: "test" } as never);
  setActivePluginRegistry(pluginRegistry);
}

function writeNativeClaudeTranscript(sessionId: string) {
  const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" } })}\n`,
  );
}

async function drainQueuedHandoffs(): Promise<void> {
  const queueContext = captureOpenClawStateWorkerContext();
  const pending = await loadPendingSessionDeliveries(queueContext);
  for (const entry of pending) {
    await drainPendingSessionDelivery({
      id: entry.id,
      queueContext,
      logLabel: "scenario session delivery",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // Bypassed boundary: server-restart-sentinel's queued generated-media turn owner. The
      // agent params mirror deliverQueuedGeneratedMediaAgentTurn; media-evidence checks skip.
      deliver: async (queued: QueuedSessionDelivery) => {
        if (queued.kind !== "agentTurn" || !queued.route) {
          throw new Error(`unexpected queued delivery ${queued.kind}`);
        }
        await dispatchAgentInProcess(
          "agent",
          {
            sessionKey: queued.sessionKey,
            message: queued.message,
            deliver: queued.route.channel !== "internal",
            bestEffortDeliver: false,
            channel: queued.route.channel,
            accountId: queued.route.accountId,
            to: queued.route.to,
            inputProvenance: queued.inputProvenance,
            sourceReplyDeliveryMode: "automatic",
            disableMessageTool: true,
            forceRestartSafeTools: true,
            idempotencyKey: queued.idempotencyKey ?? queued.messageId,
          },
          { expectFinal: true },
        );
      },
    });
  }
}

function deliverImageCompletion(taskId: string) {
  return imageGenerationTaskLifecycle.wakeTaskCompletion({
    config: configIo.cfg as OpenClawConfig,
    handle: {
      taskId,
      runId: `tool:image_generate:${taskId}`,
      requesterSessionKey: SESSION_KEY,
      requesterAgentId: "main",
      requesterOrigin: DM_ORIGIN,
      taskLabel: "portrait",
    },
    status: "ok",
    statusLabel: "completed successfully",
    result: "Generated 1 image.",
    attachments: [
      { type: "image", path: path.join(workspaceDir, `${taskId}.png`), mimeType: "image/png" },
    ],
  });
}

function workerIdempotencyKey(childRunId: string) {
  return `announce:v1:agent:main:subagent:${childRunId}:${childRunId}`;
}

function deliverWorkerCompletion(childRunId: string) {
  const childSessionKey = `agent:main:subagent:${childRunId}`;
  return deliverSubagentAnnouncement({
    requesterSessionKey: SESSION_KEY,
    requesterAgentId: "main",
    targetRequesterSessionKey: SESSION_KEY,
    triggerMessage: "Worker finished: 8 images generated.",
    steerMessage: "Worker finished: 8 images generated.",
    internalEvents: [
      {
        type: "task_completion",
        source: "subagent",
        childSessionKey,
        childSessionId: `${childRunId}-session`,
        announceType: "subagent task",
        taskLabel: "make portraits",
        status: "ok",
        statusLabel: "completed successfully",
        result: "All 8 portraits are ready.",
        replyInstruction: "Tell the user the portraits are done.",
      },
    ],
    requesterSessionOrigin: DM_ORIGIN,
    completionDirectOrigin: DM_ORIGIN,
    directOrigin: DM_ORIGIN,
    sourceSessionKey: childSessionKey,
    sourceTool: "subagent_announce",
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: workerIdempotencyKey(childRunId),
  });
}

describe("completion hand-off runaway on a finished 1:1 DM requester", () => {
  beforeAll(async () => {
    suiteRoot = await fixtureRoot.setup();
    envSnapshot = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    setTestEnvValue("HOME", suiteRoot);
    setTestEnvValue("USERPROFILE", suiteRoot);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(suiteRoot, ".openclaw"));
    storePath = path.join(suiteRoot, "sessions.json");
    workspaceDir = path.join(suiteRoot, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    configIo.cfg = {
      plugins: { enabled: false },
      agents: {
        defaults: {
          model: { primary: PRIMARY_MODEL, fallbacks: [FALLBACK_MODEL] },
          models: {
            [PRIMARY_MODEL]: { agentRuntime: { id: "claude-cli" } },
            [FALLBACK_MODEL]: { agentRuntime: { id: "claude-cli" } },
          },
          workspace: workspaceDir,
          subagents: { announceTimeoutMs: ANNOUNCE_TIMEOUT_MS },
        },
      },
      session: { store: storePath, mainKey: "main" },
    } satisfies OpenClawConfig;
    testing.setDepsForTest({ dispatchGatewayMethodInProcess: dispatchAgentInProcess as never });
  });

  beforeEach(() => {
    installScenarioPluginRegistry();
  });

  afterAll(async () => {
    testing.setDepsForTest();
    await cleanupSessionStateForTest({ stateDir: path.join(suiteRoot, ".openclaw") });
    envSnapshot?.restore();
    await fixtureRoot.cleanup();
  });

  it("1. the requester's user DM turn records the main claude-cli binding", async () => {
    const entry = {
      sessionId: REQUESTER_SESSION_ID,
      updatedAt: Date.now(),
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: DM_ORIGIN,
        origin: { provider: "discord", chatType: "direct", to: DM_ORIGIN.to, accountId: "default" },
      }),
    } as SessionEntry;
    await replaceSessionEntry({ agentId: "main", sessionKey: SESSION_KEY, storePath }, entry);
    const cfg = configIo.cfg as OpenClawConfig;
    // Bypassed boundary: auto-reply dispatch. Its policy owner resolves the session-stable
    // reply mode that a user DM turn records as CLI binding facts.
    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      CommandAuthorized: true,
      SessionKey: SESSION_KEY,
      OriginatingChannel: "discord",
      OriginatingTo: DM_ORIGIN.to,
      AccountId: "default",
    };
    const { configuredVisibleReplies, harnessDefaultVisibleReplies } = resolveVisibleRepliesPolicy({
      cfg,
      chatType: "direct",
      ctx: ctx as never,
      entry,
      sessionAgentId: "main",
      sessionKey: SESSION_KEY,
    });
    const stableToolAvailable = resolveStableMessageToolAvailability({
      cfg,
      ctx: ctx as never,
      sessionEntry: entry,
      sessionAgentId: "main",
      sessionKey: SESSION_KEY,
    });
    const userTurnMode = resolveSourceReplyVisibilityPolicy({
      cfg,
      ctx: ctx as never,
      sendPolicy: "allow",
      messageToolAvailable: stableToolAvailable,
      sessionStableMessageToolAvailable:
        (configuredVisibleReplies ?? harnessDefaultVisibleReplies) === "message_tool"
          ? stableToolAvailable
          : undefined,
      defaultVisibleReplies: harnessDefaultVisibleReplies,
    }).sessionStableSourceReplyDeliveryMode;

    await withPluginRuntimeGatewayRequestScope(
      { pluginRegistry, isWebchatConnect: () => false } as never,
      async () =>
        await agentCommandFromIngress(
          {
            allowModelOverride: false,
            message: "make me 8 portraits",
            sessionKey: SESSION_KEY,
            runId: "user-turn",
            sourceReplyDeliveryMode: userTurnMode,
            cliSessionBindingFacts: {
              extraSystemPromptStatic: "",
              sourceReplyDeliveryMode: userTurnMode,
            },
          },
          commandRuntime as never,
        ),
    );

    const binding = readRequesterEntry()?.cliSessionBindings?.["claude-cli"];
    expect(binding?.sessionId).toBe(MAIN_CLI_SESSION_ID);
    expect(binding?.messageToolPolicyHash).toBeDefined();
    userTurnPolicyHash = binding?.messageToolPolicyHash;
  });

  it("2. eight image_generate completions each hand off once and resume the main session", async () => {
    const taskIds = Array.from({ length: 8 }, (_, index) => `img-${index + 1}`);
    for (const taskId of taskIds) {
      expect(await deliverImageCompletion(taskId)).toEqual({ status: "pending" });
      await drainQueuedHandoffs();
    }

    for (const taskId of taskIds) {
      const key = `image_generate:${taskId}:ok:agent-loop`;
      expect(turnsFor(key), `hand-off turns for ${key}`).toHaveLength(1);
      expect(turnsFor(key)[0]?.outcome).toBe("ok");
      const executions = executionsFor(key);
      expect(executions, `claude-cli executions for ${key}`).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        resumeSessionId: MAIN_CLI_SESSION_ID,
        reuse: { mode: expect.stringMatching(/^reuse/) },
        messageToolPolicyHash: userTurnPolicyHash,
      });
    }
  });

  it("3. a re-delivered image completion id does not start a second hand-off turn", async () => {
    const key = "image_generate:img-3:ok:agent-loop";
    expect(await deliverImageCompletion("img-3")).toEqual({ status: "delivered" });
    await drainQueuedHandoffs();

    expect(turnsFor(key)).toHaveLength(1);
    expect(executionsFor(key)).toHaveLength(1);
    expect(channelSends).toHaveLength(8);
  });

  it("4. a worker hand-off held past announceTimeoutMs before admission is cancelled, never run", async () => {
    const key = workerIdempotencyKey("worker-1");
    const reached = createDeferredCore();
    const admission = createDeferredCore();
    admissionHolds.set(key, { reached: reached.resolve, admitted: admission.promise });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let delivery: Awaited<ReturnType<typeof deliverWorkerCompletion>>;
    try {
      const pending = deliverWorkerCompletion("worker-1");
      await reached.promise;
      await vi.advanceTimersByTimeAsync(ANNOUNCE_TIMEOUT_MS);
      delivery = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(delivery).toMatchObject({ delivered: false });
    expect(turnsFor(key)).toHaveLength(0);

    // The requester lane frees up after the announce deadline already gave up.
    admissionHolds.delete(key);
    admission.resolve();
    await gatewayTurnsSettled.get(key);

    expect(turnsFor(key).map((turn) => turn.outcome)).toEqual(["cancelled"]);
    expect(executionsFor(key)).toHaveLength(0);
  });

  it("5. the retried worker completion hands off exactly once and resumes the main session", async () => {
    const key = workerIdempotencyKey("worker-1");
    const delivery = await deliverWorkerCompletion("worker-1");

    expect(delivery).toMatchObject({ delivered: true });
    expect(turnsFor(key).filter((turn) => turn.outcome === "ok")).toHaveLength(1);
    const executions = executionsFor(key);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      resumeSessionId: MAIN_CLI_SESSION_ID,
      reuse: { mode: expect.stringMatching(/^reuse/) },
      messageToolPolicyHash: userTurnPolicyHash,
    });
  });

  it("6. a billing-exhausted hand-off is attempted once, not replayed", async () => {
    const key = workerIdempotencyKey("worker-2");
    billingExhaustedRunIds.add(key);
    const delivery = await deliverWorkerCompletion("worker-2");

    expect(delivery).toMatchObject({ delivered: false });
    const turns = turnsFor(key);
    expect(turns.map((turn) => turn.outcome)).toEqual(["error"]);
    const failure = turns[0]?.error;
    // Precondition: the Gateway saw a fallback-exhausted FailoverError of billing attempts.
    expect(isFailoverError(failure) ? failure.attempts?.map((a) => a.reason) : failure).toEqual([
      "billing",
      "billing",
    ]);
    const executions = executionsFor(key);
    expect(executions.map((execution) => execution.model)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
    for (const execution of executions) {
      expect(execution).toMatchObject({
        resumeSessionId: MAIN_CLI_SESSION_ID,
        reuse: { mode: expect.stringMatching(/^reuse/) },
      });
    }
  });

  it("7. the quota failure leaves the main claude-cli binding in the session store", () => {
    expect(readRequesterEntry()?.cliSessionBindings?.["claude-cli"]).toMatchObject({
      sessionId: MAIN_CLI_SESSION_ID,
      messageToolPolicyHash: userTurnPolicyHash,
    });
  });
});
