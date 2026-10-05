// F6: message 2 arrives while message 1 is still being processed.
//
// Production symptom: message 2 waited behind message 1 and "processing" notices showed up
// separately from two sources. DESIRED behavior asserted here: waiting is fine, but
//   (a) the user can tell that the bot is still working (a visible signal never goes silent for
//       long, also while the queued second message runs), and
//   (b) notices do not overlap or duplicate (one source per wait).
// A case that fails on a given tree is a "not passing" row. `(record)` cases pin today's behavior.
//
// Seams (all core, hermetic, fake timers, no network, no real keys):
//  - F6.1/F6.1b/F6.2*: `src/channels/typing-lifecycle.ts`, `src/channels/typing.ts` (the SDK helper
//    every channel plugin uses) and `src/auto-reply/reply/typing.ts` (the per-dispatch controller
//    created in get-reply.ts) wired together exactly like get-reply -> dispatcher does.
//  - F6.3*/F6.4*/F6.5: the REAL `dispatchInboundMessageWithBufferedDispatcher` (dispatch.ts) with an
//    injected `dispatchReplyFromConfig` that builds the real TypingController the way get-reply.ts
//    does and calls the REAL `runReplyAgent` for message 2 (queue / steer admission branch) while
//    message 1 is represented by a real, registered ReplyOperation + its own real controller.
//    The queued turn is run by the REAL queue drain + REAL `createFollowupRunner` +
//    REAL `executeFollowupTurn`; only the model call (`executeAgentTurn`), session admission,
//    delivery and accounting are stubbed (this is what followup-runner.test.ts also stubs).
//    The channel plugin is a recorder built with the real `createTypingCallbacks`.
//  - Anything that lives in a channel plugin (ackReaction / statusReactions / plugin text) is
//    plugin side and NOT testable here; F6.4r only records that core never calls those helpers.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  turn: undefined as unknown,
  execute: undefined as undefined | ((params: any) => Promise<unknown>),
  executeCalls: 0,
}));

// Stubs for the queued-turn run (admission, model call, delivery, accounting). Typing wiring stays real.
vi.mock("../../src/auto-reply/reply/followup-turn-admission.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/auto-reply/reply/followup-turn-admission.js")
  >()),
  admitFollowupTurn: async () => ({ kind: "admitted", turn: h.turn }),
  settleQueuedFollowupPresentation: async () => {},
}));
vi.mock("../../src/auto-reply/reply/agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/auto-reply/reply/agent-runner-execution.js")
  >()),
  executeAgentTurn: (params: unknown) => {
    h.executeCalls += 1;
    return h.execute?.(params);
  },
}));
vi.mock("../../src/auto-reply/reply/followup-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/auto-reply/reply/followup-delivery.js")>()),
  resolveFollowupDeliveryDecision: () => ({ kind: "suppress", reason: "silent" }),
  deliverFollowupDecision: async () => ({ kind: "completed", payloads: [] }),
}));
vi.mock("../../src/auto-reply/reply/agent-runner-result-accounting.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/auto-reply/reply/agent-runner-result-accounting.js")
  >()),
  accountFollowupTurn: async () => {},
}));

import { clearSessionQueues } from "../../src/auto-reply/reply/queue.js";
import { resolveQueueSettingsCore } from "../../src/auto-reply/reply/queue/settings.js";
import { createReplyOperation } from "../../src/auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../src/auto-reply/reply/reply-run-registry.test-support.js";
import { bindReplyOperationTyping } from "../../src/auto-reply/reply/reply-run-typing.js";
import { prepareReplyToolAuthority } from "../../src/auto-reply/reply/reply-tool-authority.js";
import { buildTestCtx } from "../../src/auto-reply/reply/test-ctx.js";
import { createMockReplyOperation } from "../../src/auto-reply/reply/test-helpers.js";
import { createTypingSignaler, resolveTypingMode } from "../../src/auto-reply/reply/typing-mode.js";
import { createTypingController } from "../../src/auto-reply/reply/typing.js";
import { createTypingKeepaliveLoop } from "../../src/channels/typing-lifecycle.js";
import { createTypingCallbacks } from "../../src/channels/typing.js";
import { validateConfigObject } from "../../src/config/validation.js";

const { dispatchInboundMessageWithBufferedDispatcher } =
  await import("../../src/auto-reply/dispatch.js");
const { runReplyAgent } = await import("../../src/auto-reply/reply/agent-runner.js");

type TypingModeName = "never" | "instant" | "thinking" | "message";
type Ev = { t: number; src: "msg1" | "msg2"; kind: "start" | "stop" };

/** A typing indicator shown by one start() is assumed visible this long (controller default cadence). */
const TYPING_VISIBLE_MS = 6_000;
/** Longest stretch without any visible typing signal that we still call "the user can tell". */
const MAX_SILENT_MS = 10_000;

/** Longest stretch inside [from, to] that is not covered by a typing start() (each covers VISIBLE ms). */
function longestSilentMs(startTimes: number[], from: number, to: number): number {
  let cursor = from;
  let worst = 0;
  for (const s of [...startTimes].sort((a, b) => a - b)) {
    const end = s + TYPING_VISIBLE_MS;
    if (end <= cursor) {
      continue;
    }
    if (s > cursor) {
      worst = Math.max(worst, Math.min(s, to) - cursor);
    }
    cursor = Math.max(cursor, end);
    if (cursor >= to) {
      return worst;
    }
  }
  return Math.max(worst, to - cursor);
}

function validates(cfg: unknown): { ok: boolean; issue?: string } {
  const r = validateConfigObject(cfg);
  return r.ok
    ? { ok: true }
    : { ok: false, issue: `${r.issues[0]?.path}: ${r.issues[0]?.message}` };
}

describe("F6 second message while the first is processing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.turn = undefined;
    h.execute = undefined;
    h.executeCalls = 0;
    replyRunTesting.resetReplyRunRegistry();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ------------------------------------------------------------------ typing primitives
  it("F6.1 typing keepalive loop: after stop()+start() a stalled provider call is never overlapped by a second one", async () => {
    // src/channels/typing-lifecycle.ts. A (v9.6) resets tickInFlight in stop(); B (v9.7) keeps it.
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    const loop = createTypingKeepaliveLoop({
      intervalMs: 1_000,
      onTick: () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        }),
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000); // tick 1 is admitted and stalls (channel API slow)
    loop.stop();
    loop.start(); // e.g. circuit breaker trip + reset, or a controller refresh
    await vi.advanceTimersByTimeAsync(3_000);
    loop.stop();
    for (const r of release) {
      r();
    }
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });

  it("F6.1b typing callbacks (what plugins use): refresh + keepalive never put more than one start() in flight, even across a stop/restart", async () => {
    // The in-flight gate in createTypingCallbacks (startInFlight) hides the loop-level difference
    // of F6.1 for plugins: expected PASS on both trees.
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    const cb = createTypingCallbacks({
      start: () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        }),
      onStartError: () => {},
      keepaliveIntervalMs: 1_000,
    });
    void cb.onReplyStart();
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      void cb.onReplyStart(); // controller refresh every 0.5 s (worst case)
      release.splice(0).forEach((r) => r());
    }
    cb.onCleanup?.();
    release.splice(0).forEach((r) => r());
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });

  /** One active turn: real TypingController (get-reply.ts:383) driving real TypingCallbacks (plugin side). */
  async function typingStartTimesFor30s(opts: {
    typingIntervalSeconds: number;
    latencyMs: number;
  }) {
    const t0 = Date.now();
    const starts: number[] = [];
    const cb = createTypingCallbacks({
      start: async () => {
        starts.push(Date.now() - t0);
        if (opts.latencyMs > 0) {
          await new Promise((r) => setTimeout(r, opts.latencyMs));
        }
      },
      onStartError: () => {},
    });
    const controller = createTypingController({
      onReplyStart: cb.onReplyStart,
      onCleanup: cb.onCleanup,
      typingIntervalSeconds: opts.typingIntervalSeconds,
      keepalive: true,
    });
    await controller.startTypingLoop();
    await vi.advanceTimersByTimeAsync(30_000);
    controller.cleanup();
    return starts;
  }
  const minGap = (xs: number[]) =>
    xs.slice(1).reduce((m, x, i) => Math.min(m, x - xs[i]!), Infinity);

  it("F6.2 default config: one active turn is kept alive by ONE keepalive loop (no duplicate start() pulses)", async () => {
    // controller loop (agents.defaults.typingIntervalSeconds, default 6 s) + plugin callbacks loop (3 s)
    // are stacked: both fire together every 6 s. start() here resolves instantly.
    const starts = await typingStartTimesFor30s({ typingIntervalSeconds: 6, latencyMs: 0 });
    expect(minGap(starts)).toBeGreaterThanOrEqual(1_000);
  });

  it("F6.2b agents.defaults.typingIntervalSeconds=3600 (valid config): the controller loop stays out of the way -> one loop, no duplicates", async () => {
    expect(validates({ agents: { defaults: { typingIntervalSeconds: 3600 } } }).ok).toBe(true);
    const starts = await typingStartTimesFor30s({ typingIntervalSeconds: 3600, latencyMs: 0 });
    expect(minGap(starts)).toBeGreaterThanOrEqual(1_000);
    expect(starts.length).toBeGreaterThanOrEqual(10); // still alive: ~1 pulse per 3 s
  });

  it("F6.2c (record) start() calls per 30 s for one turn: stacked loops cost 16 calls with an instant API, 11 with a 200 ms API (in-flight gate merges coincident ticks); typingIntervalSeconds=0 is rejected by the config schema", async () => {
    const instant = await typingStartTimesFor30s({ typingIntervalSeconds: 6, latencyMs: 0 });
    const slow = await typingStartTimesFor30s({ typingIntervalSeconds: 6, latencyMs: 200 });
    expect(instant.length).toBe(16);
    expect(slow.length).toBe(11);
    expect(validates({ agents: { defaults: { typingIntervalSeconds: 0 } } }).ok).toBe(false);
  });

  // ------------------------------------------------------------------ two-message scenarios
  let seq = 0;
  type Scenario = Awaited<ReturnType<typeof runScenario>>;

  async function runScenario(o: {
    mode: "followup" | "collect" | "steer";
    typingMode?: TypingModeName;
    typingIntervalSeconds?: number;
    arriveMs?: number;
    msg1DoneMs?: number;
    msg2RunMs?: number;
  }) {
    seq += 1;
    h.executeCalls = 0; // per scenario (F6.3d runs several scenarios in one case)
    const sessionKey = `f6-session-${seq}`;
    const typingMode: TypingModeName = o.typingMode ?? "instant";
    const typingIntervalSeconds = o.typingIntervalSeconds ?? 6;
    const arriveMs = o.arriveMs ?? 2_000;
    const msg1DoneMs = o.msg1DoneMs ?? 20_000;
    const msg2RunMs = o.msg2RunMs ?? 30_000;
    const t0 = Date.now();
    const now = () => Date.now() - t0;
    const events: Ev[] = [];
    const delivered: string[] = [];
    const injected: string[] = [];
    const exec = {
      startMs: undefined as number | undefined,
      endMs: undefined as number | undefined,
    };
    const mkPluginCallbacks = (src: Ev["src"]) =>
      createTypingCallbacks({
        start: async () => {
          events.push({ t: now(), src, kind: "start" });
        },
        stop: async () => {
          events.push({ t: now(), src, kind: "stop" });
        },
        onStartError: () => {},
      });
    const newFollowupRun = (messageId: string, prompt: string): any => ({
      prompt,
      summaryLine: prompt,
      messageId,
      enqueuedAt: Date.now(),
      originatingChannel: "whatsapp",
      originatingTo: "whatsapp:+1000",
      run: {
        sessionId: `${sessionKey}-id`,
        sessionKey,
        messageProvider: "whatsapp",
        sessionFile: "/tmp/f6-session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text"] }],
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    });

    // ---- message 1: active run (registered operation + its own real controller)
    const active = createReplyOperation({
      sessionKey,
      sessionId: `${sessionKey}-id`,
      resetTriggered: false,
    });
    active.setPhase("running");
    if (o.mode === "steer") {
      active.attachBackend({
        kind: "embedded",
        runId: "run-1",
        cancel: vi.fn(),
        claimPendingUserInputAnswer: async () => false,
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async (prompt: string) => {
            injected.push(prompt);
            return undefined;
          },
        },
      } as never);
    }
    const cb1 = mkPluginCallbacks("msg1");
    const typing1 = createTypingController({
      onReplyStart: cb1.onReplyStart,
      onCleanup: cb1.onCleanup,
      typingIntervalSeconds,
      keepalive: true,
    });
    const startLoop1 = vi.spyOn(typing1, "startTypingLoop");
    bindReplyOperationTyping(active, typing1);
    const signals1 = createTypingSignaler({
      typing: typing1,
      mode: typingMode,
      isHeartbeat: false,
    });
    await signals1.signalRunStart();
    await vi.advanceTimersByTimeAsync(1_000);
    await signals1.signalReasoningDelta(); // what a streaming run emits
    await signals1.signalTextDelta("working on it");
    await vi.advanceTimersByTimeAsync(arriveMs - 1_000);

    // ---- message 2 arrives (REAL dispatch layer + REAL runReplyAgent admission)
    const tArrive = now();
    const startLoop1CallsBeforeArrival = startLoop1.mock.calls.length;
    const followupRun2 = newFollowupRun("m2", "second message");
    if (o.mode === "steer") {
      active.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun2));
    }
    h.turn = {
      runId: "run-2",
      queued: followupRun2,
      operation: createMockReplyOperation({ key: sessionKey }).replyOperation,
      config: {},
      session: {
        kind: "session",
        key: sessionKey,
        current: () => undefined,
        publish: () => undefined,
        adopt: () => undefined,
      },
      sendPolicy: "allow",
      preflightCompactionApplied: false,
    };
    h.execute = async (params: any) => {
      exec.startMs = now();
      // Same signal the real executor sends at turn start (agent-runner-execution.ts, execution phase hook).
      void params.typingSignals.signalExecutionActivity?.();
      await new Promise((r) => setTimeout(r, 1_000));
      void params.typingSignals.signalTextDelta?.("partial answer");
      await new Promise((r) => setTimeout(r, msg2RunMs - 1_000));
      exec.endMs = now();
      return { runId: "run-2", outcome: { kind: "rejected", payload: { text: "done" } } };
    };
    const cb2 = mkPluginCallbacks("msg2");
    let typing2: ReturnType<typeof createTypingController> | undefined;
    let runResult: unknown = "not-run";
    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx({
        SessionKey: sessionKey,
        MessageSid: "m2",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "whatsapp:+1000",
      }),
      cfg: {},
      dispatcherOptions: {
        deliver: async (payload: { text?: string }) => {
          delivered.push(payload.text ?? "");
        },
        typingCallbacks: cb2,
      },
      dispatchReplyFromConfig: async ({ replyOptions }: any) => {
        // Same construction as get-reply.ts: one controller per dispatch.
        const typing = createTypingController({
          onReplyStart: replyOptions.onReplyStart,
          onCleanup: replyOptions.onTypingCleanup,
          typingIntervalSeconds,
          keepalive: true,
        });
        replyOptions.onTypingController?.(typing);
        typing2 = typing;
        runResult = await runReplyAgent({
          commandBody: "second message",
          followupRun: followupRun2,
          queueKey: sessionKey,
          resolvedQueue: { mode: o.mode, debounceMs: 0 },
          shouldSteer: o.mode === "steer",
          shouldFollowup: o.mode !== "steer",
          isActive: true,
          isRunActive: () => true,
          opts: replyOptions,
          typing,
          sessionKey,
          replyOperation: active,
          sessionCtx: {
            Provider: "whatsapp",
            MessageSid: "m2",
            OriginatingChannel: "whatsapp",
            OriginatingTo: "whatsapp:+1000",
          },
          defaultModel: "anthropic/claude-opus-4-6",
          resolvedVerboseLevel: "off",
          isNewSession: false,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: "message_end",
          shouldInjectGroupIntro: false,
          typingMode,
        } as never);
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    } as never);
    const tAdmitted = now();

    // ---- message 1 finishes (same order as agent-runner-core.ts: operation clears, then typing completes)
    let tMsg1Done = -1;
    if (o.mode === "steer") {
      await vi.advanceTimersByTimeAsync(10_000);
    } else {
      await vi.advanceTimersByTimeAsync(Math.max(0, msg1DoneMs - tAdmitted));
      tMsg1Done = now();
      active.complete();
      typing1.markRunComplete();
      typing1.markDispatchIdle();
      await vi.advanceTimersByTimeAsync(msg2RunMs + 6_000);
    }
    const tEnd = now();
    // late callbacks on message 2's controller must stay inert; prove it with one more start attempt
    await typing2?.startTypingLoop();
    await vi.advanceTimersByTimeAsync(1_000);
    clearSessionQueues([sessionKey]);
    return {
      events,
      delivered,
      injected,
      runResult,
      exec,
      tArrive,
      tAdmitted,
      tMsg1Done,
      tEnd,
      typing1,
      typing2: typing2!,
      startLoop1CallsFromSteer: startLoop1.mock.calls.length - startLoop1CallsBeforeArrival,
      queuedTurnRan: h.executeCalls,
    };
  }

  const starts = (s: Scenario, src?: Ev["src"]) =>
    s.events.filter((e) => e.kind === "start" && (!src || e.src === src)).map((e) => e.t);

  function assertQueuedTurnRan(s: Scenario) {
    // Guard against a vacuous PASS: the second message must really have been queued and then run.
    expect(s.runResult).toBeUndefined();
    expect(s.queuedTurnRan).toBe(1);
    expect(s.exec.startMs).toBeGreaterThanOrEqual(s.tMsg1Done);
  }

  it.each(["followup", "collect"] as const)(
    "F6.3 queue mode %s: while the queued second message is being worked on, the user still sees a typing signal at least every 10 s",
    async (mode) => {
      const s = await runScenario({ mode });
      assertQueuedTurnRan(s);
      const silent = longestSilentMs(starts(s), s.tMsg1Done, s.exec.endMs!);
      // Observed today: the queued turn reuses message 2's dispatch controller, which dispatch.ts
      // already sealed (markRunComplete+markDispatchIdle) -> no typing at all for the queued turn.
      expect(silent).toBeLessThanOrEqual(MAX_SILENT_MS);
    },
  );

  it("F6.3a queue mode followup: while message 2 waits behind message 1 the chat keeps showing typing (message 1's own loop)", async () => {
    const s = await runScenario({ mode: "followup" });
    assertQueuedTurnRan(s);
    expect(longestSilentMs(starts(s), s.tArrive, s.tMsg1Done)).toBeLessThanOrEqual(MAX_SILENT_MS);
  });

  it("F6.3c (record) typingMode decides what a waiting/queued second message shows (instant|thinking|message|never), group default resolves to message", () => {
    const resolve = (
      configured: TypingModeName | undefined,
      isGroupChat: boolean,
      wasMentioned: boolean,
    ) => resolveTypingMode({ configured, isGroupChat, wasMentioned, isHeartbeat: false });
    expect(resolve(undefined, false, false)).toBe("instant"); // DM
    expect(resolve(undefined, true, true)).toBe("instant"); // group, mentioned
    expect(resolve(undefined, true, false)).toBe("message"); // group, no mention info (LINE WORKS passes no WasMentioned)
    expect(resolve("never", true, true)).toBe("never"); // agents.defaults.typingMode / agents.list[].typingMode wins
    expect(resolve("thinking", false, false)).toBe("thinking");
  });

  it("F6.3d (record) followup mode, per typingMode: start() count of message 2's own controller (arrival pulse + queued run) -- queued run never types", async () => {
    const observed: Record<
      string,
      { msg2Starts: number; msg2StartsInQueuedRun: number; msg2Stops: number }
    > = {};
    for (const typingMode of ["instant", "thinking", "message", "never"] as const) {
      const s = await runScenario({ mode: "followup", typingMode });
      assertQueuedTurnRan(s);
      observed[typingMode] = {
        msg2Starts: starts(s, "msg2").length,
        msg2StartsInQueuedRun: starts(s, "msg2").filter((t) => t >= s.tMsg1Done).length,
        msg2Stops: s.events.filter((e) => e.src === "msg2" && e.kind === "stop").length,
      };
    }
    expect(observed).toEqual({
      instant: { msg2Starts: 1, msg2StartsInQueuedRun: 0, msg2Stops: 1 },
      thinking: { msg2Starts: 1, msg2StartsInQueuedRun: 0, msg2Stops: 1 },
      message: { msg2Starts: 0, msg2StartsInQueuedRun: 0, msg2Stops: 1 },
      never: { msg2Starts: 0, msg2StartsInQueuedRun: 0, msg2Stops: 1 },
    });
  });

  // ------------------------------------------------------------------ overlap / duplicate notices
  it("F6.4 queue mode followup: a queued second message adds no typing events of its own while message 1's indicator is live (one source per wait)", async () => {
    const s = await runScenario({ mode: "followup" });
    assertQueuedTurnRan(s);
    const msg2During = s.events.filter(
      (e) => e.src === "msg2" && e.t >= s.tArrive && e.t < s.tMsg1Done,
    );
    // Observed: msg2 emits start+stop at its arrival (a second source, and the plugin's stop() may clear msg1's indicator).
    expect(msg2During).toEqual([]);
    // core sends no text notice for a queued message (anything like "processing" would be plugin side)
    expect(s.delivered.length).toBeLessThanOrEqual(1);
  });

  it("F6.4s queue mode steer (default): an injected second message emits no typing events of its own (no stray stop() into message 1's live indicator)", async () => {
    const s = await runScenario({ mode: "steer", arriveMs: 20_000 });
    expect(s.injected).toEqual(["second message"]); // really steered, not queued
    expect(s.queuedTurnRan).toBe(0);
    const msg2 = s.events.filter((e) => e.src === "msg2");
    // Observed: a lone stop() from msg2 (dispatcher onIdle -> typingCallbacks.onIdle) although msg2 never started typing.
    // Matrix's plugin maps stop() to "typing=false" for the whole room.
    expect(msg2).toEqual([]);
    expect(s.delivered.length).toBeLessThanOrEqual(1);
  });

  it("F6.4r (record) core never calls ack/status reaction helpers: those 'processing' signals are plugin side", () => {
    const root = fileURLToPath(new URL("../../src/auto-reply/", import.meta.url));
    const hits: string[] = [];
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      // production sources only: skip *.test.ts, *.test-support.ts, *.test-utils.ts, *.test-helpers.ts
      if (!rel.endsWith(".ts") || rel.includes(".test")) {
        continue;
      }
      const text = readFileSync(`${root}${rel}`, "utf8");
      if (/ack-reactions|status-reactions|ackReaction|statusReactions|setQueued/.test(text)) {
        hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });

  // ------------------------------------------------------------------ steer (default mode)
  it("F6.5 queue mode steer (default): message 2 is injected into the live turn, its own controller is cleaned up, message 1's typing is refreshed", async () => {
    const s = await runScenario({ mode: "steer", arriveMs: 20_000 });
    expect(s.runResult).toBeUndefined(); // no own reply for the steered message
    expect(s.injected).toEqual(["second message"]);
    expect(s.queuedTurnRan).toBe(0); // no second agent turn
    expect(s.typing2.isActive()).toBe(false); // msg2's controller is inert (cleaned up)
    expect(starts(s, "msg2")).toEqual([]); // ... and never pulsed typing
    expect(s.startLoop1CallsFromSteer).toBeGreaterThanOrEqual(1); // msg1 controller refreshed (startTypingLoop) by the steer
    expect(s.typing1.isActive()).toBe(true);
  });

  // ------------------------------------------------------------------ config surface
  it("F6.6 (record) messages.queue: mode values, byChannel key set (LINE/LINE WORKS must use the global key), debounceMsByChannel, resolution", () => {
    for (const mode of ["steer", "followup", "collect", "interrupt"]) {
      expect(validates({ messages: { queue: { mode } } }).ok).toBe(true);
    }
    expect(validates({ messages: { queue: { mode: "queue" } } }).ok).toBe(false);
    for (const ch of [
      "whatsapp",
      "telegram",
      "discord",
      "irc",
      "googlechat",
      "slack",
      "mattermost",
      "signal",
      "imessage",
      "msteams",
      "webchat",
      "matrix",
    ]) {
      expect(validates({ messages: { queue: { byChannel: { [ch]: "followup" } } } }).ok).toBe(true);
    }
    const lw = validates({ messages: { queue: { byChannel: { lineworks: "followup" } } } });
    expect(lw.ok).toBe(false);
    expect(lw.issue).toContain("Unrecognized key");
    expect(validates({ messages: { queue: { byChannel: { line: "followup" } } } }).ok).toBe(false);
    // the debounce map is a free-form record, so any channel id works there
    expect(
      validates({ messages: { queue: { debounceMsByChannel: { lineworks: 1500 } } } }).ok,
    ).toBe(true);
    expect(validates({ messages: { inbound: { byChannel: { lineworks: 800 } } } }).ok).toBe(true);
    // what a config that validates resolves to for a plugin channel
    const settings = (cfg: unknown, channel: string) =>
      resolveQueueSettingsCore({ cfg: cfg as never, channel });
    expect(settings({}, "lineworks")).toMatchObject({ mode: "steer", debounceMs: 500, cap: 20 });
    expect(settings({ messages: { queue: { mode: "followup" } } }, "lineworks").mode).toBe(
      "followup",
    );
    expect(
      settings({ messages: { queue: { debounceMsByChannel: { lineworks: 1500 } } } }, "lineworks")
        .debounceMs,
    ).toBe(1500);
    // the resolver itself would honor byChannel.lineworks; only the strict schema blocks it
    expect(
      settings({ messages: { queue: { byChannel: { lineworks: "collect" } } } }, "lineworks").mode,
    ).toBe("collect");
    // typing / reaction keys are accepted
    expect(
      validates({ agents: { defaults: { typingMode: "message", typingIntervalSeconds: 3 } } }).ok,
    ).toBe(true);
    expect(
      validates({
        messages: {
          ackReaction: "eyes",
          ackReactionScope: "all",
          statusReactions: { enabled: true },
        },
      }).ok,
    ).toBe(true);
  });
});
