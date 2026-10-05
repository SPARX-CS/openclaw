// F3: the same person sends two messages a few seconds apart. Desired: nothing is dropped
// (both messages get a reply, or one merged reply answers both).
//
// History: in 7.1-2 reply 1 was discarded by a "stale-foreground" fence and only reply 2 arrived
// (seed note RESULT_codex_kagura.md). 9.6 replaced the fence with a FIFO lease (src/auto-reply/dispatch.ts).
//
// Every `it` asserts the DESIRED behaviour; one that fails on a tree is a "not passing" row.
// `(record)` marks a test that only documents the current behaviour (not a defect or not fixable in core).
//
// Layers (see the support files for what is real and what is a stand-in):
//   F3.1-F3.4, F3.7, F3.8   dispatcher + FIFO lease (dispatchInboundMessageWithBufferedDispatcher)
//   F3.5                    queue / admission: messages.queue.mode, steer injection, follow-up queue, interrupt
//   F3.6                    duplicate-id guards (inbound dedupe, queue message-id dedupe)
//   F3.9                    core inbound debouncer (messages.inbound.*)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../src/auto-reply/inbound-debounce.js";
import {
  claimInboundDedupe,
  resetInboundDedupe,
} from "../../src/auto-reply/reply/inbound-dedupe.js";
import { clearSessionQueues, enqueueFollowupRun } from "../../src/auto-reply/reply/queue.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../src/auto-reply/reply/queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "../../src/auto-reply/reply/queue/recent-message-ids.js";
import { resolveQueueSettings } from "../../src/auto-reply/reply/queue/settings-runtime.js";
import {
  followupTurnHook,
  MSG2_TEXT,
  MSG3_TEXT,
  runQueueScenario,
  type QueueScenarioLedger,
} from "./f3-queue-modes.support.js";
import {
  buildCtx,
  CHANNEL,
  createDeferred,
  dispatchMessage,
  finalReceipt,
  noReplyResult,
  queuedFinalResult,
  type Delivery,
} from "./f3-two-messages.support.js";

// ---- mocks for the queue-level scenarios (F3.5). They only cut disk/network/model access. ----
vi.mock("../../src/agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: async () => undefined,
}));
vi.mock("../../src/auto-reply/reply/session-system-events.js", () => ({
  drainFormattedSystemEvents: async () => undefined,
}));
vi.mock("../../src/auto-reply/reply/get-reply-run-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/auto-reply/reply/get-reply-run-helpers.js")>()),
  loadSessionUpdatesRuntime: async () => ({
    ensureSkillSnapshot: async ({ sessionEntry }: { sessionEntry: unknown }) => ({ sessionEntry }),
  }),
}));
// The model run of a queued follow-up. The stand-in lives in f3-queue-modes.support.ts and, like the
// real runner, defers while the session's reply lane is still owned by the active run.
vi.mock("../../src/auto-reply/reply/followup-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/auto-reply/reply/followup-runner.js")>()),
  createFollowupRunner: () => async (run: { prompt: string }) => followupTurnHook.run(run),
}));

const texts = (deliveries: Delivery[]) => deliveries.map((d) => d.text);

describe("F3 two messages in a row: dispatcher level (FIFO lease)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("F3.1 two messages 3 s apart (msg1 slow): both replies are delivered, in order", async () => {
    const deliveries: Delivery[] = [];
    const m1Started = createDeferred();
    const m2Started = createDeferred();
    const releaseM1 = createDeferred();
    const startedAt: Record<string, number> = {};
    const turn = async (params: any) => {
      const sid = params.ctx.MessageSid;
      startedAt[sid] = Date.now();
      if (sid === "m1") {
        m1Started.resolve();
        await releaseM1.promise;
        params.dispatcher.sendFinalReply({ text: "reply 1" });
        return queuedFinalResult();
      }
      m2Started.resolve();
      params.dispatcher.sendFinalReply({ text: "reply 2" });
      return queuedFinalResult();
    };

    const d1 = dispatchMessage({ ctx: buildCtx({ MessageSid: "m1" }), turn, deliveries });
    await m1Started.promise;
    await vi.advanceTimersByTimeAsync(3_000);
    const d2 = dispatchMessage({ ctx: buildCtx({ MessageSid: "m2" }), turn, deliveries });
    await m2Started.promise;
    expect(startedAt.m2 - startedAt.m1).toBeGreaterThanOrEqual(3_000);

    releaseM1.resolve();
    const [r1, r2] = await Promise.all([d1, d2]);

    expect(texts(deliveries)).toEqual(["reply 1", "reply 2"]);
    expect(finalReceipt(r1)).toMatchObject({
      queuedFinal: true,
      finalCount: 1,
      delivered: 1,
      cancelled: 0,
    });
    expect(finalReceipt(r2)).toMatchObject({
      queuedFinal: true,
      finalCount: 1,
      delivered: 1,
      cancelled: 0,
    });
  });

  it("F3.2 reply 1 is not discarded by a newer message that already finished its turn (7.1-2 stale-foreground regression)", async () => {
    // 7.1-2: when msg2 became visible first, msg1's pending final was cancelled and its dispatch
    // ended with final count 0 ("no queued reply payloads"). Here msg1 is very slow (120 s) and
    // msg2's whole turn finishes first, so msg2's final is ready while msg1 is still running.
    const deliveries: Delivery[] = [];
    const cancelled: Array<string | undefined> = [];
    const skipped: Array<string | undefined> = [];
    const m1Started = createDeferred();
    const m2TurnDone = createDeferred();
    const releaseM1 = createDeferred();
    const turn = async (params: any) => {
      const sid = params.ctx.MessageSid;
      if (sid === "m1") {
        m1Started.resolve();
        await releaseM1.promise;
        params.dispatcher.sendFinalReply({ text: "reply 1" });
        return queuedFinalResult();
      }
      params.dispatcher.sendFinalReply({ text: "reply 2" });
      m2TurnDone.resolve();
      return queuedFinalResult();
    };
    const observers = {
      onBeforeDeliverCancelled: (payload: { text?: string }) => cancelled.push(payload.text),
      onSkip: (payload: { text?: string }) => skipped.push(payload.text),
    };

    const d1 = dispatchMessage({
      ctx: buildCtx({ MessageSid: "m1" }),
      turn,
      deliveries,
      dispatcherOptions: observers,
    });
    await m1Started.promise;
    await vi.advanceTimersByTimeAsync(3_000);
    const d2 = dispatchMessage({
      ctx: buildCtx({ MessageSid: "m2" }),
      turn,
      deliveries,
      dispatcherOptions: observers,
    });
    await m2TurnDone.promise;
    await vi.advanceTimersByTimeAsync(117_000);
    // msg2 is ready but must not overtake msg1 (nothing visible yet, nothing cancelled yet).
    expect(texts(deliveries)).toEqual([]);

    releaseM1.resolve();
    const [r1, r2] = await Promise.all([d1, d2]);

    expect(texts(deliveries)).toContain("reply 1");
    expect(texts(deliveries)).toEqual(["reply 1", "reply 2"]);
    expect(cancelled).toEqual([]);
    expect(skipped).toEqual([]);
    expect(finalReceipt(r1)).toMatchObject({ finalCount: 1, delivered: 1, cancelled: 0 });
    expect(finalReceipt(r2)).toMatchObject({ finalCount: 1, delivered: 1, cancelled: 0 });
  });

  it.each([
    ["its agent turn throws", "turn-throws"],
    ["its delivery (deliver) throws", "deliver-throws"],
    ["it produces no reply (silent)", "silent"],
  ] as const)(
    "F3.3 failure isolation: msg1 %s -> msg2 still gets its reply",
    async (_label, variant) => {
      const deliveries: Delivery[] = [];
      const m1Started = createDeferred();
      const m2Started = createDeferred();
      const releaseM1 = createDeferred();
      const turn = async (params: any) => {
        const sid = params.ctx.MessageSid;
        if (sid === "m1") {
          m1Started.resolve();
          await releaseM1.promise;
          if (variant === "turn-throws") {
            throw new Error("agent turn failed");
          }
          if (variant === "silent") {
            return noReplyResult();
          }
          params.dispatcher.sendFinalReply({ text: "reply 1" });
          return queuedFinalResult();
        }
        m2Started.resolve();
        params.dispatcher.sendFinalReply({ text: "reply 2" });
        return queuedFinalResult();
      };
      const deliver =
        variant === "deliver-throws"
          ? async (payload: { text?: string }, info: { kind: string }) => {
              if (payload.text === "reply 1") {
                throw new Error("push failed");
              }
              deliveries.push({ kind: info.kind, text: payload.text });
            }
          : undefined;

      const d1 = dispatchMessage({
        ctx: buildCtx({ MessageSid: "m1" }),
        turn,
        deliveries,
        deliver,
        dispatcherOptions: { onError: () => {} },
      });
      const d1Settled = d1.then(
        () => "resolved",
        () => "rejected",
      );
      await m1Started.promise;
      await vi.advanceTimersByTimeAsync(3_000);
      const d2 = dispatchMessage({ ctx: buildCtx({ MessageSid: "m2" }), turn, deliveries });
      await m2Started.promise;
      expect(texts(deliveries)).toEqual([]);

      releaseM1.resolve();
      const r2 = await d2;
      await d1Settled;

      expect(texts(deliveries)).toEqual(["reply 2"]);
      expect(finalReceipt(r2)).toMatchObject({ finalCount: 1, delivered: 1, cancelled: 0 });
    },
  );

  it.each([
    [
      "different chat target, same session",
      { OriginatingTo: "testchannel:person-2", From: "testchannel:person-2" },
    ],
    ["different session, same target", { SessionKey: "agent:main:testchannel:direct:person-1b" }],
    ["different account, same session and target", { AccountId: "second" }],
  ] as const)("F3.4 %s does not wait for msg1 (isolation holds)", async (_label, overrides) => {
    const deliveries: Delivery[] = [];
    const m1Started = createDeferred();
    const releaseM1 = createDeferred();
    const turn = async (params: any) => {
      if (params.ctx.MessageSid === "m1") {
        m1Started.resolve();
        await releaseM1.promise;
        params.dispatcher.sendFinalReply({ text: "reply 1" });
        return queuedFinalResult();
      }
      params.dispatcher.sendFinalReply({ text: "reply other" });
      return queuedFinalResult();
    };

    const d1 = dispatchMessage({ ctx: buildCtx({ MessageSid: "m1" }), turn, deliveries });
    await m1Started.promise;
    await vi.advanceTimersByTimeAsync(3_000);
    const d2 = dispatchMessage({
      ctx: buildCtx({ MessageSid: "m2", ...overrides }),
      turn,
      deliveries,
    });
    await d2;
    // msg2 is delivered while msg1 is still running.
    expect(texts(deliveries)).toEqual(["reply other"]);

    releaseM1.resolve();
    await d1;
    expect(texts(deliveries)).toEqual(["reply other", "reply 1"]);
  });

  it("F3.7 (record) a stuck msg1 holds msg2's own reply: the FIFO lease has no timeout (released right after msg1 settles)", async () => {
    // Not a drop: msg2's reply is delivered as soon as msg1's dispatch ends. The wait is bounded only
    // by msg1's own run timeout. Relevant when msg2 has a reply of its own (it is not steered/queued).
    const deliveries: Delivery[] = [];
    const m1Started = createDeferred();
    const m2TurnDone = createDeferred();
    const releaseM1 = createDeferred();
    const turn = async (params: any) => {
      if (params.ctx.MessageSid === "m1") {
        m1Started.resolve();
        await releaseM1.promise;
        params.dispatcher.sendFinalReply({ text: "reply 1" });
        return queuedFinalResult();
      }
      params.dispatcher.sendFinalReply({ text: "reply 2" });
      m2TurnDone.resolve();
      return queuedFinalResult();
    };
    const d1 = dispatchMessage({ ctx: buildCtx({ MessageSid: "m1" }), turn, deliveries });
    await m1Started.promise;
    await vi.advanceTimersByTimeAsync(3_000);
    const d2 = dispatchMessage({ ctx: buildCtx({ MessageSid: "m2" }), turn, deliveries });
    await m2TurnDone.promise;

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(texts(deliveries)).toEqual([]); // 30 minutes later msg2's ready reply is still held

    releaseM1.resolve();
    await Promise.all([d1, d2]);
    expect(texts(deliveries)).toEqual(["reply 1", "reply 2"]);
  });

  it("F3.8 (record) the plain dispatcher (dispatchReplyWithDispatcher) takes no FIFO lease: both replies arrive, in completion order", async () => {
    // dispatch.ts: dispatchInboundMessageWithDispatcher / ...ProjectedDispatcher never reserve the
    // foreground lease. A channel plugin that dispatches through them is not ordered (not dropped).
    const deliveries: Delivery[] = [];
    const m1Started = createDeferred();
    const releaseM1 = createDeferred();
    vi.doMock("../../src/auto-reply/reply/dispatch-from-config.js", () => ({
      dispatchReplyFromConfig: async (params: any) => {
        if (params.ctx.MessageSid === "m1") {
          m1Started.resolve();
          await releaseM1.promise;
          params.dispatcher.sendFinalReply({ text: "reply 1" });
        } else {
          params.dispatcher.sendFinalReply({ text: "reply 2" });
        }
        return queuedFinalResult();
      },
    }));
    try {
      // A second instance of dispatch.js (query string) that sees the mocked dispatchReplyFromConfig;
      // the shared registries (reply-run registry, queues) of the other tests are left untouched.
      const dispatchModule = "../../src/auto-reply/dispatch.js?f3-plain-dispatcher";
      const { dispatchInboundMessageWithDispatcher } = await import(
        /* @vite-ignore */ dispatchModule
      );
      const run = (sid: string) =>
        dispatchInboundMessageWithDispatcher({
          ctx: buildCtx({ MessageSid: sid }),
          cfg: {},
          dispatcherOptions: {
            deliver: async (payload: { text?: string }, info: { kind: string }) => {
              deliveries.push({ kind: info.kind, text: payload.text });
            },
          },
        } as never);
      const d1 = run("m1");
      await m1Started.promise;
      await vi.advanceTimersByTimeAsync(3_000);
      const d2 = run("m2");
      await d2;
      releaseM1.resolve();
      await d1;
      expect([...texts(deliveries)].sort()).toEqual(["reply 1", "reply 2"]); // nothing dropped
      expect(texts(deliveries)).toEqual(["reply 2", "reply 1"]); // but no ordering guarantee
    } finally {
      vi.doUnmock("../../src/auto-reply/reply/dispatch-from-config.js");
    }
  });
});

// ------------------------------------------------------------------------------------------------
// F3.5 queue modes: msg1 is running (a registered reply operation); msg2 arrives 3 s later.
// ------------------------------------------------------------------------------------------------
describe("F3 two messages in a row: queue modes (messages.queue.mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const scenario = (options: Parameters<typeof runQueueScenario>[1] = {}) =>
    runQueueScenario(vi, options);
  const queuedReply = (prompt: string) => `reply to queued: ${prompt}`;

  it("F3.5 config keys: default is steer; messages.queue.mode and messages.queue.byChannel.<channel> select the mode", () => {
    const modeOf = (queue?: Record<string, unknown>) =>
      resolveQueueSettings({
        cfg: (queue ? { messages: { queue } } : {}) as never,
        channel: CHANNEL,
      }).mode;
    expect(modeOf()).toBe("steer");
    for (const mode of ["steer", "followup", "collect", "interrupt"]) {
      expect(modeOf({ mode })).toBe(mode);
    }
    expect(modeOf({ mode: "interrupt", byChannel: { [CHANNEL]: "followup" } })).toBe("followup");
    expect(modeOf({ byChannel: { otherchannel: "collect" } })).toBe("steer");
    // A mode stored in the session by a past `/queue <mode>` directive beats the config.
    const cfg = { messages: { queue: { mode: "followup" } } } as never;
    expect(
      resolveQueueSettings({
        cfg,
        channel: CHANNEL,
        sessionEntry: { sessionId: "s", updatedAt: 1, queueMode: "interrupt" } as never,
      }).mode,
    ).toBe("interrupt");
  });

  it.each([
    ["default config (no messages.queue)", undefined],
    ["messages.queue.mode = steer", "steer"],
  ] as const)(
    "F3.5a %s: msg2 is steered into msg1's live turn, msg1's reply is delivered, nothing is queued or aborted",
    async (_label, mode) => {
      // msg2 gets no reply of its own; msg1's final answer is the one reply (whether it covers msg2's
      // text depends on the model and cannot be tested here).
      const l = await scenario({ mode });
      expect(l.settingsMode).toBe("steer");
      expect(l.later[0]).toMatchObject({ shouldSteer: true, isActive: true });
      expect(l.later[0].admission).toMatchObject({ status: "accepted", mode: "steer" });
      expect(l.injected).toEqual([MSG2_TEXT]);
      expect(l.msg1Aborted).toBe(false);
      expect(l.followupPrompts).toEqual([]);
      expect(l.visible).toEqual(["reply 1"]);
    },
  );

  it("F3.5b messages.queue.mode = followup: msg2 is queued and answered after msg1's reply (one reply per message, in order)", async () => {
    const l = await scenario({ mode: "followup" });
    expect(l.settingsMode).toBe("followup");
    expect(l.later[0]).toMatchObject({
      shouldSteer: false,
      shouldFollowup: true,
      queueAction: "enqueue-followup",
    });
    expect(l.later[0].admission).toMatchObject({ status: "accepted", mode: "followup" });
    expect(l.msg1Aborted).toBe(false);
    expect(l.injected).toEqual([]);
    expect(l.followupPrompts).toEqual([MSG2_TEXT]);
    expect(l.visible).toEqual(["reply 1", queuedReply(MSG2_TEXT)]);
  });

  it("F3.5c messages.queue.mode = collect: msg1 replies separately, msg2 is answered afterwards as a collected prompt", async () => {
    const l = await scenario({ mode: "collect" });
    expect(l.settingsMode).toBe("collect");
    expect(l.later[0].admission).toMatchObject({ status: "accepted", mode: "followup" });
    expect(l.msg1Aborted).toBe(false);
    expect(l.followupPrompts).toHaveLength(1);
    expect(l.followupPrompts[0]).toContain(MSG2_TEXT);
    expect(l.visible).toHaveLength(2);
    expect(l.visible[0]).toBe("reply 1");
    expect(l.visible[1]).toContain(MSG2_TEXT);
  });

  it("F3.5d per-channel override messages.queue.byChannel.<channel> = followup behaves like the global followup mode", async () => {
    const l = await scenario({ queue: { byChannel: { [CHANNEL]: "followup" } } });
    expect(l.settingsMode).toBe("followup");
    expect(l.visible).toEqual(["reply 1", queuedReply(MSG2_TEXT)]);
  });

  it("F3.5e default steer, live turn refuses the injected message: msg2 falls back to the ordered queue and is answered after msg1", async () => {
    const l = await scenario({ later: [{ sid: "m2", text: MSG2_TEXT, rejectInjection: true }] });
    expect(l.settingsMode).toBe("steer");
    expect(l.later[0].admission).toMatchObject({ status: "accepted", mode: "followup" });
    expect(l.injected).toEqual([]);
    expect(l.msg1Aborted).toBe(false);
    expect(l.visible).toEqual(["reply 1", queuedReply(MSG2_TEXT)]);
  });

  it.each([
    ["default config", {}],
    ["steer", { mode: "steer" }],
    ["followup", { mode: "followup" }],
    ["collect", { mode: "collect" }],
    [
      "steer + injection refused",
      { later: [{ sid: "m2", text: MSG2_TEXT, rejectInjection: true }] },
    ],
  ] as const)(
    "F3.5f %s: msg1's reply is never dropped and msg2 is not dropped either",
    async (_label, options) => {
      const l: QueueScenarioLedger = await scenario(options as never);
      expect(l.msg1Aborted).toBe(false);
      expect(l.visible[0]).toBe("reply 1");
      // msg2 reached a turn: injected into msg1's live turn, or queued and answered afterwards.
      const reachedATurn =
        l.injected.includes(MSG2_TEXT) ||
        l.followupPrompts.some((prompt) => prompt.includes(MSG2_TEXT));
      expect(reachedATurn).toBe(true);
    },
  );

  it("F3.5g (record) messages.queue.mode = interrupt reproduces the old symptom: msg1 is aborted, its reply is never sent, only msg2 is answered", async () => {
    // Not the default. `interrupt` means "abort the running turn and run the newest message";
    // `/reset` forces the same path (get-reply-run-admission.ts: activeRunQueueMode).
    const l = await scenario({ mode: "interrupt" });
    expect(l.settingsMode).toBe("interrupt");
    expect(l.later[0]).toMatchObject({
      shouldSteer: false,
      shouldFollowup: false,
      queueAction: "run-now",
    });
    expect(l.msg1Aborted).toBe(true);
    expect(l.visible).toEqual(["reply 2"]);
    expect(l.visible).not.toContain("reply 1");
    expect(l.msg1Result).toMatchObject({ queuedFinal: false, counts: { final: 0 } });
  });

  it("F3.5h (record) interrupt while msg1 ignores the abort for 15 s: msg2 is not run, its only output is the 'still shutting down' notice, held behind msg1 until it settles", async () => {
    const l = await scenario({ mode: "interrupt", abortNeverSettles: true });
    expect(l.msg1Aborted).toBe(true);
    expect(l.later[0].admissionReply).toContain("still shutting down");
    expect(l.visibleWhileMsg1Stuck).toEqual([]); // the user sees nothing while msg1 is stuck
    expect(l.visible).toHaveLength(1);
    expect(l.visible[0]).toContain("still shutting down");
    expect(l.visible).not.toContain("reply 1");
    expect(l.visible).not.toContain("reply 2");
  });

  it("F3.5i three messages (msg2's injection refused, msg3 arrives): all three are accounted for and msg1's reply comes first", async () => {
    // A and B route msg3 differently when a follow-up is already queued (A: ordered behind msg2 via
    // queueAdmissionState; B: steering is attempted again and chained). Both must keep every message.
    const l = await scenario({
      later: [
        { sid: "m2", text: MSG2_TEXT, rejectInjection: true },
        { sid: "m3", text: MSG3_TEXT },
      ],
    });
    expect(l.msg1Aborted).toBe(false);
    expect(l.visible[0]).toBe("reply 1");
    const reached = (text: string) =>
      l.injected.includes(text) || l.followupPrompts.some((prompt) => prompt.includes(text));
    expect(reached(MSG2_TEXT)).toBe(true);
    expect(reached(MSG3_TEXT)).toBe(true);
    // Every queued message is answered exactly once.
    const queuedAnswers = l.visible.filter((text) => text.startsWith("reply to queued:"));
    expect(queuedAnswers).toHaveLength(l.followupPrompts.length);
  });

  it("F3.5j (record) three messages, msg2 queued: msg3 is ordered behind msg2 on A (tri-state admission) but steered into the live turn on B (steering restored for newer messages)", async () => {
    const queuePolicy: Record<string, unknown> =
      await import("../../src/auto-reply/reply/queue-policy.js");
    const isA = typeof queuePolicy.resolveReplyQueueAdmissionState === "function";
    const l = await scenario({
      later: [
        { sid: "m2", text: MSG2_TEXT, rejectInjection: true },
        { sid: "m3", text: MSG3_TEXT },
      ],
    });
    expect(l.later[0].admission).toMatchObject({ status: "accepted", mode: "followup" });
    if (isA) {
      expect(l.later[1].shouldSteer).toBe(false);
      expect(l.later[1].admission).toMatchObject({ status: "accepted", mode: "followup" });
      expect(l.injected).toEqual([]);
      expect(l.followupPrompts).toEqual([MSG2_TEXT, MSG3_TEXT]);
      expect(l.visible).toEqual(["reply 1", queuedReply(MSG2_TEXT), queuedReply(MSG3_TEXT)]);
    } else {
      expect(l.later[1].shouldSteer).toBe(true);
      expect(l.later[1].admission).toMatchObject({ status: "accepted", mode: "steer" });
      expect(l.injected).toEqual([MSG3_TEXT]);
      expect(l.followupPrompts).toEqual([MSG2_TEXT]);
      expect(l.visible).toEqual(["reply 1", queuedReply(MSG2_TEXT)]);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// F3.6 duplicate-id guards: what a channel plugin that re-uses MessageSid/messageId would lose.
// ------------------------------------------------------------------------------------------------
describe("F3 two messages in a row: duplicate-id guards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInboundDedupe();
    resetRecentQueuedMessageIdDedupe();
    clearSessionQueues(["f3-dup-queue"]);
  });
  afterEach(() => {
    clearSessionQueues(["f3-dup-queue"]);
    resetInboundDedupe();
    resetRecentQueuedMessageIdDedupe();
    vi.useRealTimers();
  });

  const claim = (sid: string | undefined, body: string) =>
    claimInboundDedupe(
      buildCtx({ MessageSid: sid, Body: body, RawBody: body, CommandBody: body }) as never,
    );

  it("F3.6a two different messages with distinct MessageSids are both admitted", () => {
    const first = claim("sid-1", "hello");
    expect(first.status).toBe("claimed");
    first.commit?.();
    const second = claim("sid-2", "and one more thing");
    expect(second.status).toBe("claimed");
  });

  it("F3.6b a provider redelivery (same MessageSid, same text) is dropped, in flight and after commit (retry safety)", () => {
    const first = claim("sid-1", "hello");
    expect(first.status).toBe("claimed");
    expect(claim("sid-1", "hello").status).toBe("inflight");
    first.commit?.();
    expect(claim("sid-1", "hello").status).toBe("duplicate");
  });

  it("F3.6c (record) a DIFFERENT message that re-uses the previous MessageSid is dropped as a duplicate for 20 min (the text is not compared; the plugin must give each message its own id)", async () => {
    const first = claim("sid-1", "message one");
    first.commit?.();
    expect(claim("sid-1", "message two, different text").status).toBe("duplicate");
    await vi.advanceTimersByTimeAsync(19 * 60_000);
    expect(claim("sid-1", "message two, different text").status).toBe("duplicate");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(claim("sid-1", "message two, different text").status).toBe("claimed"); // window is 20 min
  });

  it("F3.6d (record) a message without any MessageSid is never deduplicated: nothing is dropped (a redelivery would run twice)", () => {
    expect(claim(undefined, "message one").status).toBe("invalid");
    expect(claim(undefined, "message two").status).toBe("invalid");
  });

  it("F3.6e (record) queue admission also refuses a DIFFERENT prompt carrying the same messageId for 5 min, even after the first was drained", async () => {
    const settings = createQueueSettings({ mode: "followup", debounceMs: 0 });
    const enqueue = (prompt: string, messageId: string) =>
      enqueueFollowupRun(
        "f3-dup-queue",
        createQueueTestRun({
          prompt,
          messageId,
          originatingChannel: CHANNEL as never,
          originatingTo: "testchannel:person-1",
        }),
        settings,
        "message-id",
        undefined,
        false,
      );
    expect(enqueue("message one", "dup-1")).toBe(true);
    expect(enqueue("message two", "dup-2")).toBe(true); // distinct ids: both queued
    clearSessionQueues(["f3-dup-queue"]); // the queue drains / is cleared; the recent-id memory stays
    expect(enqueue("message three", "dup-1")).toBe(false); // same id as message one, different text: refused
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(enqueue("message three", "dup-1")).toBe(true); // window is 5 min
  });
});

// ------------------------------------------------------------------------------------------------
// F3.9 core inbound debouncer: the config that makes ONE merged reply answer both messages.
// (Only for channels whose plugin routes inbound through createInboundDebouncer.)
// ------------------------------------------------------------------------------------------------
describe("F3 two messages in a row: core inbound debounce (messages.inbound.*)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function sendTwoMessages(cfg: Record<string, unknown>) {
    const flushes: string[][] = [];
    const debounceMs = resolveInboundDebounceMs({ cfg: cfg as never, channel: CHANNEL });
    const debouncer = createInboundDebouncer<{ key: string; text: string }>({
      debounceMs,
      buildKey: (item) => item.key,
      onFlush: (items) => {
        const completion = Promise.resolve().then(() => {
          flushes.push(items.map((item) => item.text));
        });
        return { admission: completion, completion };
      },
    });
    await debouncer.enqueue({ key: "person-1", text: "message one" });
    await vi.advanceTimersByTimeAsync(3_000);
    await debouncer.enqueue({ key: "person-1", text: "message two" });
    await vi.advanceTimersByTimeAsync(10_000);
    await debouncer.drain?.();
    return { debounceMs, flushes };
  }

  it("F3.9a default config: no debounce, the two messages become two separate turns (nothing merged, nothing lost)", async () => {
    const { debounceMs, flushes } = await sendTwoMessages({});
    expect(debounceMs).toBe(0);
    expect(flushes).toEqual([["message one"], ["message two"]]);
  });

  it.each([
    [
      "messages.inbound.byChannel.<channel> = 4000",
      { messages: { inbound: { byChannel: { [CHANNEL]: 4000 } } } },
    ],
    ["messages.inbound.debounceMs = 4000", { messages: { inbound: { debounceMs: 4000 } } }],
  ] as const)(
    "F3.9b %s: the two messages (3 s apart) are merged into ONE turn",
    async (_label, cfg) => {
      const { debounceMs, flushes } = await sendTwoMessages(cfg);
      expect(debounceMs).toBe(4000);
      expect(flushes).toEqual([["message one", "message two"]]);
    },
  );
});
