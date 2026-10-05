// Queue-level fixture for F3.5: what happens to message 1 and to the later messages for each
// `messages.queue.mode` when they arrive while message 1's turn is still running.
//
// REAL production code (identical import paths on trees A and B):
//   resolveQueueSettings (via prepareReplyRunAdmission), prepareReplyRunAdmission (mode ->
//   shouldSteer / shouldFollowup / interrupt of the active run), resolveActiveRunQueueAction,
//   runReplyAgent (steer injection, follow-up enqueue), the follow-up queue + drain (enqueue,
//   collect, debounce, retry), the reply-run registry (operation, abort), the dispatcher + FIFO lease.
// STAND-INS (the only fakes):
//   - the agent backend of message 1: a registered reply operation whose backend accepts or rejects
//     injected messages and cancels when aborted;
//   - the model run of an interrupting message and of a queued follow-up: they just emit text. The
//     follow-up stand-in defers (throws FollowupRunDeferredError) while the session's reply lane is
//     still owned, exactly like followup-turn-admission.ts does.
// The test file must install the vi.mock calls listed at the bottom (vi.mock is hoisted per file).
import { setTimeout as realDelay } from "node:timers/promises";
import { prepareReplyRunAdmission } from "../../src/auto-reply/reply/get-reply-run-admission.js";
import { resetInboundDedupe } from "../../src/auto-reply/reply/inbound-dedupe.js";
import { resolveActiveRunQueueAction } from "../../src/auto-reply/reply/queue-policy.js";
import { clearSessionQueues } from "../../src/auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../src/auto-reply/reply/queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "../../src/auto-reply/reply/queue/recent-message-ids.js";
import { hasPendingFollowupQueueWork } from "../../src/auto-reply/reply/queue/state.js";
import { FollowupRunDeferredError } from "../../src/auto-reply/reply/queue/types.js";
import { REPLY_OPERATION_RUN_STATE } from "../../src/auto-reply/reply/reply-operation-run-state.js";
import {
  createReplyOperation,
  replyRunRegistry,
} from "../../src/auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../src/auto-reply/reply/reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "../../src/auto-reply/reply/reply-tool-authority.js";
import {
  buildCtx,
  createDeferred,
  dispatchMessage,
  noReplyResult,
  queuedFinalResult,
} from "./f3-two-messages.support.js";
import type { Delivery } from "./f3-two-messages.support.js";

export const SESSION_KEY = "agent:main:testchannel:direct:person-1";
export const MSG1_TEXT = "message one: please check my order";
export const MSG2_TEXT = "message two: and the delivery date?";
export const MSG3_TEXT = "message three: also my invoice";

/** Hook the test file wires into vi.mock("…/followup-runner.js"): the stand-in for a queued follow-up turn. */
export const followupTurnHook: { run: (run: { prompt: string }) => Promise<void> } = {
  run: async () => {},
};

export type QueueMode = "steer" | "followup" | "collect" | "interrupt";

export type LaterMessage = {
  sid: string;
  text: string;
  /** The live turn refuses this message when it is injected (steer then falls back to the ordered queue). */
  rejectInjection?: boolean;
};

export type QueueScenarioOptions = {
  /** undefined = no `messages.queue` config at all (the default). */
  mode?: QueueMode;
  /** Full `messages.queue` object (e.g. { byChannel: { testchannel: "followup" } }); overrides `mode`. */
  queue?: Record<string, unknown>;
  /** Messages that arrive while message 1 runs, 3 s apart (default: one message, MSG2_TEXT). */
  later?: LaterMessage[];
  /** msg1 never settles after the abort (only meaningful for interrupt). */
  abortNeverSettles?: boolean;
};

export type LaterRecord = {
  sid: string;
  text: string;
  shouldSteer?: boolean;
  shouldFollowup?: boolean;
  isActive?: boolean;
  /** resolveActiveRunQueueAction() with the prepared admission facts. */
  queueAction?: string;
  /** Admission status that runReplyAgent recorded (steer accepted / queued as follow-up / ...). */
  admission?: { status?: string; mode?: string; reason?: string };
  /** Reply produced by the admission step itself (e.g. "Previous run is still shutting down"). */
  admissionReply?: string;
  result?: unknown;
  /** Resolved (real signal, not a timer) when this message's turn has returned. */
  turnDone?: { promise: Promise<void>; resolve: () => void };
};

export type QueueScenarioLedger = {
  settingsMode: string | undefined;
  msg1Aborted: boolean;
  /** Prompts injected into msg1's live turn (steer). */
  injected: string[];
  /** Prompts executed by the follow-up queue after msg1 (followup / collect / steer fallback). */
  followupPrompts: string[];
  /** Everything the user would see, in order. */
  visible: string[];
  /** What the user had seen while msg1 was still stuck after the abort (only the stuck case). */
  visibleWhileMsg1Stuck?: string[];
  later: LaterRecord[];
  msg1Result: unknown;
};

export async function runQueueScenario(
  vitest: typeof import("vitest").vi,
  options: QueueScenarioOptions = {},
): Promise<QueueScenarioLedger> {
  // The test runtime sets OPENCLAW_TEST_FAST=1, which turns the follow-up queue's debounce/retry
  // pacing (500 ms by default) into a hot loop. Production paces it, so switch the shortcut off.
  vitest.stubEnv("OPENCLAW_TEST_FAST", "0");
  try {
    return await runQueueScenarioInner(vitest, options);
  } finally {
    vitest.unstubAllEnvs();
    clearSessionQueues([SESSION_KEY]);
    replyRunTesting.resetReplyRunRegistry();
  }
}

async function runQueueScenarioInner(
  vitest: typeof import("vitest").vi,
  options: QueueScenarioOptions,
): Promise<QueueScenarioLedger> {
  replyRunTesting.resetReplyRunRegistry();
  clearSessionQueues([SESSION_KEY]);
  // The duplicate-id guards are process-global: start every scenario from a clean slate.
  resetInboundDedupe();
  resetRecentQueuedMessageIdDedupe();

  const laterMessages: LaterMessage[] = options.later ?? [{ sid: "m2", text: MSG2_TEXT }];
  const rejected = new Set(laterMessages.filter((m) => m.rejectInjection).map((m) => m.text));
  const cfg = options.queue
    ? { messages: { queue: options.queue } }
    : options.mode
      ? { messages: { queue: { mode: options.mode } } }
      : {};
  const deliveries: Delivery[] = [];
  const injected: string[] = [];
  const followupPrompts: string[] = [];
  let msg1Aborted = false;
  const records: LaterRecord[] = laterMessages.map((m) => ({
    sid: m.sid,
    text: m.text,
    turnDone: createDeferred(),
  }));
  let settingsMode: string | undefined;

  followupTurnHook.run = async (run) => {
    // The real follow-up runner defers (and the drain retries) while the session's reply lane is
    // still owned by the active run (followup-turn-admission.ts "active-run").
    if (replyRunRegistry.get(SESSION_KEY)) {
      throw new FollowupRunDeferredError("Follow-up reply lane is still active (active-run)");
    }
    followupPrompts.push(run.prompt);
    deliveries.push({ kind: "final", text: `reply to queued: ${run.prompt}` });
  };

  const m1Started = createDeferred();
  const m1Outcome = createDeferred<"final" | "aborted">();

  const msg1Turn = async (params: any) => {
    const op = createReplyOperation({
      sessionKey: SESSION_KEY,
      sessionId: "session-1",
      resetTriggered: false,
    });
    op.setPhase("running");
    op.attachBackend({
      kind: "embedded",
      runId: "run-1",
      cancel: () => {
        msg1Aborted = true;
        if (!options.abortNeverSettles) {
          m1Outcome.resolve("aborted");
        }
      },
      messageInjection: {
        isAvailable: () => true,
        queueMessage: async (prompt: string) => {
          if (rejected.has(prompt)) {
            throw new Error("live turn no longer accepts input");
          }
          injected.push(prompt);
        },
      },
    } as never);
    m1Started.resolve();
    const outcome = await m1Outcome.promise;
    if (outcome === "final") {
      params.dispatcher.sendFinalReply({ text: "reply 1" });
      // Production completes the operation only after delivery settled (after-clear barrier).
      await params.dispatcher.waitForIdle?.();
    }
    op.complete();
    return outcome === "final" ? queuedFinalResult() : noReplyResult();
  };

  const laterTurn = (message: LaterMessage, record: LaterRecord) => async (params: any) => {
    try {
      return await laterTurnBody(message, record, params);
    } finally {
      record.turnDone?.resolve();
    }
  };

  const laterTurnBody = async (message: LaterMessage, record: LaterRecord, params: any) => {
    const sessionCtx = params.ctx;
    const followupRun = createQueueTestRun({
      prompt: message.text,
      messageId: sessionCtx.MessageSid,
      originatingChannel: "testchannel" as never,
      originatingTo: "testchannel:person-1",
      originatingChatType: "direct",
    });
    Object.assign(followupRun.run, {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: "session-1",
      sessionFile: SESSION_KEY,
      messageProvider: "testchannel",
      config: cfg,
    });
    // msg1's operation was admitted for the same sender/config: give it the same tool authority.
    const activeOperation = replyRunRegistry.get(SESSION_KEY);
    if (activeOperation && !activeOperation.toolAuthorityFingerprint) {
      activeOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
    }

    const typing = {
      cleanup: vitest.fn(),
      markRunComplete: vitest.fn(),
      markDispatchIdle: vitest.fn(),
      startTypingLoop: vitest.fn(async () => {}),
      startTypingOnText: vitest.fn(async () => {}),
      refreshTypingTtl: vitest.fn(),
      onReplyStart: vitest.fn(async () => {}),
      isActive: () => false,
    };
    const entry = { sessionId: "session-1", updatedAt: 1 };
    const context = {
      params: {
        ctx: sessionCtx,
        sessionCtx,
        cfg,
        agentId: "main",
        agentDir: "/tmp/agent",
        directives: {},
        modelState: { allowedModelCatalog: [], resolveThinkingCatalog: async () => [] },
        provider: "anthropic",
        model: "claude",
        typing,
        opts: params.replyOptions,
        sessionKey: SESSION_KEY,
        sessionId: "session-1",
        storePath: undefined,
        sessionStore: { [SESSION_KEY]: entry },
        resolvedThinkLevel: "off",
        isNewSession: false,
      },
      sessionEntry: entry,
      traceRunPhase: <T>(_name: string, run: () => T) => run(),
      baseBodyFinal: message.text,
      prefixedBodyBase: message.text,
      hasUserBody: true,
      workspaceDir: "/tmp/workspace",
      skillsWorkspaceDir: "/tmp/workspace",
      useFastReplyRuntime: false,
      thinkingRuntime: "embedded",
      isHeartbeat: false,
      effectiveResetTriggered: false,
      getInboundContext: () => ({ inboundUserContext: "" }),
      getSessionEntry: () => entry,
      refreshInboundContextAfterAdmissionWait: async () => {},
    };

    const prepared: any = await prepareReplyRunAdmission(context as never);
    if (prepared.kind === "reply") {
      record.admissionReply = prepared.reply?.text;
      if (prepared.reply) {
        params.dispatcher.sendFinalReply(prepared.reply);
      }
      return queuedFinalResult();
    }
    settingsMode = prepared.resolvedQueue.mode;
    record.shouldSteer = prepared.shouldSteer;
    record.shouldFollowup = prepared.shouldFollowup;
    record.isActive = prepared.isActive;
    // runReplyAgent passes the same facts to resolveActiveRunQueueAction.
    // (A passes queueAdmissionState + queueMode, B passes hasQueuedFollowups: give both.)
    record.queueAction = resolveActiveRunQueueAction({
      queueAdmissionState: prepared.queueAdmissionState,
      hasQueuedFollowups: prepared.hasQueuedFollowups,
      isActive: prepared.isActive,
      isHeartbeat: false,
      shouldFollowup: prepared.shouldFollowup,
      queueMode: prepared.resolvedQueue.mode,
      resetTriggered: false,
    } as never);
    const steerWillBeTried = prepared.shouldSteer && prepared.isActive;
    if (!steerWillBeTried && record.queueAction === "run-now") {
      // This message runs a fresh turn of its own (the model run is the only stand-in).
      params.dispatcher.sendFinalReply({ text: "reply 2" });
      return queuedFinalResult();
    }
    const payload = await prepared.runReplyAgent({
      commandBody: message.text,
      followupRun,
      queueKey: prepared.queueKey,
      resolvedQueue: prepared.resolvedQueue,
      shouldSteer: prepared.shouldSteer,
      shouldFollowup: prepared.shouldFollowup,
      queueAdmissionState: prepared.queueAdmissionState,
      hasQueuedFollowups: prepared.hasQueuedFollowups,
      isActive: prepared.isActive,
      isRunActive: () => true,
      opts: params.replyOptions,
      typing,
      sessionEntry: entry,
      sessionStore: { [SESSION_KEY]: entry },
      sessionKey: SESSION_KEY,
      defaultModel: "anthropic/claude",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      sessionCtx,
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
    record.admission = params.replyOptions?.[REPLY_OPERATION_RUN_STATE]?.admission;
    if (payload) {
      params.dispatcher.sendFinalReply(payload);
      return queuedFinalResult();
    }
    return noReplyResult();
  };

  const d1 = dispatchMessage({
    ctx: buildCtx({
      MessageSid: "m1",
      Body: MSG1_TEXT,
      RawBody: MSG1_TEXT,
      CommandBody: MSG1_TEXT,
    }),
    turn: msg1Turn,
    deliveries,
    cfg,
  });
  await m1Started.promise;

  const laterDispatches: Promise<unknown>[] = [];
  for (const [index, message] of laterMessages.entries()) {
    await vitest.advanceTimersByTimeAsync(3_000);
    laterDispatches.push(
      dispatchMessage({
        ctx: buildCtx({
          MessageSid: message.sid,
          Body: message.text,
          RawBody: message.text,
          CommandBody: message.text,
        }),
        turn: laterTurn(message, records[index]),
        deliveries,
        cfg,
      }),
    );
    // Let it pass admission. Interrupt mode aborts msg1 here and waits up to 15 s for it to settle:
    // in the never-settles case only fake time can end that wait, otherwise wait for the real signal
    // (the first scenario of a process pays real dynamic-import time that fake timers cannot skip).
    if (options.abortNeverSettles) {
      await vitest.advanceTimersByTimeAsync(100);
    } else {
      await records[index].turnDone?.promise;
      await vitest.advanceTimersByTimeAsync(0);
    }
  }

  let visibleWhileMsg1Stuck: string[] | undefined;
  let msg1Result: unknown;
  if (options.abortNeverSettles) {
    // msg1 ignores the abort: the interrupting message waits for the 15 s settle timeout and then
    // gets a notice; that notice is itself a final reply and queues behind msg1 in the FIFO lease.
    await vitest.advanceTimersByTimeAsync(16_000);
    visibleWhileMsg1Stuck = deliveries.map((d) => d.text ?? "");
    m1Outcome.resolve("aborted");
    msg1Result = await d1;
    for (const [index, dispatched] of laterDispatches.entries()) {
      records[index].result = await dispatched;
    }
  } else {
    for (const [index, dispatched] of laterDispatches.entries()) {
      records[index].result = await dispatched;
    }
    // msg1's turn now produces its final answer (unless it was aborted above).
    m1Outcome.resolve(msg1Aborted ? "aborted" : "final");
    msg1Result = await d1;
  }
  // Let the follow-up queue (500 ms debounce, retries while the lane is owned) drain.
  const queueIdle = () => !hasPendingFollowupQueueWork([SESSION_KEY]);
  for (let step = 0; step < 240 && !queueIdle(); step += 1) {
    await vitest.advanceTimersByTimeAsync(250);
    await realDelay(1);
  }
  await vitest.advanceTimersByTimeAsync(1_000);

  return {
    settingsMode,
    msg1Aborted,
    injected,
    followupPrompts,
    visible: deliveries.map((d) => d.text ?? ""),
    ...(visibleWhileMsg1Stuck ? { visibleWhileMsg1Stuck } : {}),
    later: records,
    msg1Result,
  };
}

/**
 * Documentation only: the vi.mock calls the test file must declare (hoisted, so they cannot live here).
 *   ../../src/agents/auth-profiles/session-override.js   resolveSessionAuthSelection: async () => undefined
 *   ../../src/auto-reply/reply/session-system-events.js  drainFormattedSystemEvents: async () => undefined
 *   ../../src/auto-reply/reply/get-reply-run-helpers.js  loadSessionUpdatesRuntime: skills snapshot stub (rest real)
 *   ../../src/auto-reply/reply/followup-runner.js        createFollowupRunner -> followupTurnHook.run
 */
export const QUEUE_MODE_MOCKS_NOTE = "see comment";
