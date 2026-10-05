// F7 (plugin timer + board): the in-house LINE WORKS plugin does NOT push progress through core. It owns one
// "still processing" timer per conversation (intervalAck: first push after firstDelayMs, then every intervalMs; one
// shared timer for all dispatches of the same account+to; fixed template text). This file REPLICATES that timer structure
// (lineworks-monitor.ts: LineworksIntervalAckState ~L237, the timer + pushIntervalAck ~L608-681, the finally ~L800-815)
// and applies the minimal edits of reference/lineworks-monitor.progress-example.diff:
//   board.attach(key) per dispatch -> replyOptions to core -> board.render(key, Date.now()) ?? template at push time
//   -> progress.detach() in finally.
// The model run behind the replica's dispatch is the REAL runReplyAgent path built in f7-text-channel-core-path.support.ts
// (fake LLM -> real session loop -> real tool handlers -> real createAgentRunEventHandler -> the board's callbacks),
// except where a test says "hand-fed" (core-shaped payloads straight into the attached callbacks).
// Prod timing: firstDelayMs 30 s, intervalMs 60 s, direct chats only. Fake timers; no network; no real channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Register the harness mocks before the runner (and the support file) are imported.
await vi.hoisted(async () => {
  await import("../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js");
});

import { registerAgentSessionLoopTestLifecycle } from "../../src/agents/sessions/agent-session-loop-correctness.test-support.js";
import { setupAgentRunnerTestHooks } from "../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js";
import {
  captureReplyOptions,
  createDeferred,
  createEmbeddedRun,
  installFakeEmbeddedRun,
  payloadTexts,
  settle,
  until,
} from "./f7-text-channel-core-path.support.js";
import {
  boardRef,
  itemEvent,
  leaksIn,
  leaky,
  toolStart,
} from "./f7-text-channel-progress.support.js";

setupAgentRunnerTestHooks();
registerAgentSessionLoopTestLifecycle();

const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;
const sec = (n: number) => n * 1000;
const ACCOUNT = "acct-1";
const TO = "lineworks:user:u1";
const KEY = `${ACCOUNT}\u0000${TO}`;
const TEMPLATE = "処理中...（${ELAPSED}秒経過）";
const TOOL_ARGS = { path: leaky.path, url: leaky.url, command: leaky.command };
const FAILURE = new Error(
  `ENOENT ${leaky.path}; GET ${leaky.url} -> 401 (Authorization: Bearer sk-live-0123456789abcdef0123456789)`,
);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-05T13:00:00Z"), toFake: [...FAKE_TIMERS] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------------------------------------------------------------
// Replica of the plugin's interval-ack structure (lineworks-monitor.ts), with the board edits of the example diff.
// ------------------------------------------------------------------------------------------------------------------
type AckState = {
  activeDispatches: number;
  count: number;
  firstTimer: ReturnType<typeof setTimeout> | null;
  repeatTimer: ReturnType<typeof setInterval> | null;
  startedAt: number;
};
type Board = ReturnType<typeof boardRef.createProgressBoard>;

function createPluginReplica(params: {
  board?: Board; // undefined = today's prod behavior (template only)
  firstDelayMs?: number;
  intervalMs?: number;
  scope?: "direct" | "group" | "both";
}) {
  const { board, firstDelayMs = sec(30), intervalMs = sec(60), scope = "direct" } = params;
  const t0 = Date.now();
  const pushed: Array<{ at: number; to: string; text: string }> = [];
  const intervalAckStates = new Map<string, AckState>();
  const log: string[] = [];
  // fake pushMessageLineworks
  const pushMessage = async (to: string, text: string) => {
    pushed.push({ at: Date.now() - t0, to, text });
  };
  const clearIntervalAckState = (state: AckState) => {
    if (state.firstTimer) {
      clearTimeout(state.firstTimer);
      state.firstTimer = null;
    }
    if (state.repeatTimer) {
      clearInterval(state.repeatTimer);
      state.repeatTimer = null;
    }
  };
  const renderIntervalAckText = (template: string, elapsedMs: number) =>
    template.replace(/\$\{ELAPSED\}/g, String(Math.round(elapsedMs / 1000)));

  async function dispatch(args: {
    accountId?: string;
    to?: string;
    isGroup?: boolean;
    run: (replyOptions: Record<string, unknown> | undefined) => Promise<void>;
  }) {
    const accountId = args.accountId ?? ACCOUNT;
    const to = args.to ?? TO;
    const dispatchStartedAt = Date.now();
    // resolveLineworksIntervalAck: scope "direct" skips groups
    const spec =
      scope === "direct" && args.isGroup ? null : { firstDelayMs, intervalMs, template: TEMPLATE };
    let intervalAckKey: string | null = null;
    let intervalAckState: AckState | null = null;
    let progress: ReturnType<Board["attach"]> | null = null; // [diff]
    try {
      if (spec) {
        intervalAckKey = `${accountId}\u0000${to}`;
        progress = board?.attach(intervalAckKey) ?? null; // [diff] one attachment per dispatch
        const existingState = intervalAckStates.get(intervalAckKey);
        if (existingState) {
          intervalAckState = existingState;
          existingState.activeDispatches += 1;
          log.push("joined");
        } else {
          const state: AckState = {
            activeDispatches: 1,
            count: 0,
            firstTimer: null,
            repeatTimer: null,
            startedAt: dispatchStartedAt,
          };
          intervalAckState = state;
          intervalAckStates.set(intervalAckKey, state);
          log.push("started");
          const pushIntervalAck = () => {
            if (intervalAckStates.get(intervalAckKey!) !== state) {
              return;
            }
            state.count += 1;
            const startedAt = Date.now();
            const text =
              board?.render(intervalAckKey!, startedAt) ?? // [diff]
              renderIntervalAckText(spec.template, startedAt - state.startedAt);
            void pushMessage(to, text);
          };
          state.firstTimer = setTimeout(() => {
            state.firstTimer = null;
            if (intervalAckStates.get(intervalAckKey!) !== state) {
              return;
            }
            pushIntervalAck();
            state.repeatTimer = setInterval(pushIntervalAck, spec.intervalMs);
            state.repeatTimer.unref?.();
          }, spec.firstDelayMs);
          state.firstTimer.unref?.();
        }
      }
      // core.channel.inbound.dispatchReply({ ..., replyOptions: progress?.replyOptions }) lives inside run()
      await args.run(progress?.replyOptions as Record<string, unknown> | undefined);
    } finally {
      progress?.detach(); // [diff]
      if (intervalAckKey && intervalAckState) {
        intervalAckState.activeDispatches -= 1;
        if (intervalAckState.activeDispatches === 0) {
          clearIntervalAckState(intervalAckState);
          if (intervalAckStates.get(intervalAckKey) === intervalAckState) {
            intervalAckStates.delete(intervalAckKey);
          }
        }
      }
    }
  }
  return { dispatch, pushed, texts: () => pushed.map((p) => p.text), intervalAckStates, log };
}

/** A dispatch whose model run is the real runReplyAgent path with the attached callbacks as reply options. */
function realRun(onResult?: (r: unknown) => void) {
  return async (replyOptions: Record<string, unknown> | undefined) => {
    const { opts } = captureReplyOptions(replyOptions ?? {});
    const result = await createEmbeddedRun(opts).run();
    onResult?.(result);
  };
}

describe("F7.15 real core path behind the plugin's timer (firstDelay 30 s / interval 60 s)", () => {
  it("F7.15 tool phases: the first push names the running tool, a later push names the next one, with elapsed seconds", async () => {
    const pdf = createDeferred();
    const search = createDeferred();
    const probe = installFakeEmbeddedRun({
      turns: [
        { calls: [{ id: "call-pdf", name: "pdf", args: TOOL_ARGS }] },
        { calls: [{ id: "call-search", name: "web_search", args: { query: "経費精算 規程" } }] },
        { text: "完了しました。" },
      ],
      tools: { pdf: { gate: pdf.promise }, web_search: { gate: search.promise } },
    });
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    let result: unknown;
    const done = plugin.dispatch({ run: realRun((r) => (result = r)) });

    await until(() => probe.toolsStarted.includes("pdf"), "pdf started");
    await vi.advanceTimersByTimeAsync(sec(29));
    expect(plugin.texts()).toEqual([]); // nothing before firstDelay
    await vi.advanceTimersByTimeAsync(sec(1)); // t=30
    expect(plugin.pushed.map((p) => [p.at, p.text])).toEqual([
      [sec(30), "PDFを読み取り中です（経過30秒）"],
    ]);

    await vi.advanceTimersByTimeAsync(sec(20)); // t=50: pdf done, web_search starts
    pdf.resolve();
    await until(() => probe.toolsStarted.includes("web_search"), "web_search started");
    await vi.advanceTimersByTimeAsync(sec(40)); // t=90: interval push
    expect(plugin.pushed.map((p) => [p.at, p.text])).toEqual([
      [sec(30), "PDFを読み取り中です（経過30秒）"],
      [sec(90), "Web検索中です（経過40秒・全体1分30秒）"],
    ]);

    await vi.advanceTimersByTimeAsync(sec(50)); // t=140: finish before the next push (150 s)
    search.resolve();
    await done;
    await settle();
    expect(payloadTexts(result)).toEqual(["完了しました。"]);
    expect(plugin.intervalAckStates.size).toBe(0); // timers cleared with the last dispatch
    expect(board.has(KEY)).toBe(false); // board forgot the key
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(plugin.texts()).toHaveLength(2);
    expect(leaksIn(plugin.texts())).toEqual([]);
  });

  it("F7.15b thinking gap (no tool signal): 考え中 with elapsed; model start comes from the real onAgentRunStart", async () => {
    const model = createDeferred();
    const probe = installFakeEmbeddedRun({
      turns: [{ text: "お待たせしました。", gate: model.promise }],
      tools: {},
    });
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    let result: unknown;
    let runStarts = 0;
    const done = plugin.dispatch({
      run: async (opts) => {
        const cap = captureReplyOptions(opts ?? {});
        const r = createEmbeddedRun(cap.opts).run();
        await until(() => cap.cap.runStart > 0, "onAgentRunStart");
        runStarts = cap.cap.runStart;
        result = await r;
      },
    });
    await until(() => probe.modelCalls >= 1, "model request issued");
    await vi.advanceTimersByTimeAsync(sec(95)); // pushes at 30 s and 90 s
    expect(plugin.pushed.map((p) => [p.at, p.text])).toEqual([
      [sec(30), "考え中です（経過30秒）"],
      [sec(90), "考え中です（経過1分30秒）"],
    ]);
    model.resolve();
    await done;
    await settle();
    expect(runStarts).toBe(1);
    expect(payloadTexts(result)).toEqual(["お待たせしました。"]);
    expect(plugin.intervalAckStates.size).toBe(0);
    expect(board.has(KEY)).toBe(false);
  });

  it("F7.15c a tool fails and the run continues: the next pushes name the failed place (no raw error), with total elapsed", async () => {
    const failAt5 = createDeferred();
    const model = createDeferred();
    const probe = installFakeEmbeddedRun({
      turns: [
        { calls: [{ id: "call-pdf", name: "pdf", args: TOOL_ARGS }] },
        { text: "PDFを開けませんでした。", gate: model.promise },
      ],
      tools: { pdf: { gate: failAt5.promise, throws: FAILURE } },
    });
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    const done = plugin.dispatch({ run: realRun() });
    await until(() => probe.toolsStarted.includes("pdf"), "pdf started");
    await vi.advanceTimersByTimeAsync(sec(5));
    failAt5.resolve(); // the tool fails at t=5 s
    await until(() => probe.modelCalls >= 2, "model asked again after the failure");
    await vi.advanceTimersByTimeAsync(sec(85)); // t=90
    expect(plugin.pushed.map((p) => [p.at, p.text])).toEqual([
      [sec(30), "PDFの読み取りで失敗しました。別の方法を試しています。（全体の経過30秒）"],
      [sec(90), "PDFの読み取りで失敗しました。別の方法を試しています。（全体の経過1分30秒）"],
    ]);
    expect(leaksIn(plugin.texts())).toEqual([]);
    model.resolve();
    await done;
    await settle();
    expect(plugin.intervalAckStates.size).toBe(0);
    expect(board.has(KEY)).toBe(false);
  });

  it("F7.15d a failure followed by a new tool: the failure line gives way to the new stage", async () => {
    const failAt5 = createDeferred();
    const search = createDeferred();
    const probe = installFakeEmbeddedRun({
      turns: [
        { calls: [{ id: "call-pdf", name: "pdf", args: TOOL_ARGS }] },
        { calls: [{ id: "call-search", name: "web_search", args: { query: "規程" } }] },
        { text: "見つかりました。" },
      ],
      tools: {
        pdf: { gate: failAt5.promise, throws: FAILURE },
        web_search: { gate: search.promise },
      },
    });
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    const done = plugin.dispatch({ run: realRun() });
    await until(() => probe.toolsStarted.includes("pdf"), "pdf started");
    await vi.advanceTimersByTimeAsync(sec(5));
    failAt5.resolve();
    await until(() => probe.toolsStarted.includes("web_search"), "web_search started"); // starts at t=5
    await vi.advanceTimersByTimeAsync(sec(25)); // t=30
    expect(plugin.texts()).toEqual(["Web検索中です（経過25秒）"]);
    search.resolve();
    await done;
    await settle();
  });

  it("F7.15e baseline (today's prod, no board): the pushed text is only the fixed template", async () => {
    const model = createDeferred();
    const probe = installFakeEmbeddedRun({
      turns: [{ text: "ok", gate: model.promise }],
      tools: {},
    });
    const plugin = createPluginReplica({});
    const done = plugin.dispatch({ run: realRun() });
    await until(() => probe.modelCalls >= 1, "model request issued");
    await vi.advanceTimersByTimeAsync(sec(95));
    expect(plugin.texts()).toEqual(["処理中...（30秒経過）", "処理中...（90秒経過）"]);
    model.resolve();
    await done;
    await settle();
  });
});

describe("F7.16 hand-fed callbacks (core-shaped payloads) through the plugin timer", () => {
  /** A dispatch that stays open until `release()`; the test drives the attached callbacks itself. */
  function openDispatch(
    plugin: ReturnType<typeof createPluginReplica>,
    extra: { to?: string; isGroup?: boolean } = {},
  ) {
    const release = createDeferred();
    let opts: Record<string, any> | undefined;
    const done = plugin.dispatch({
      ...extra,
      run: async (o) => {
        opts = o;
        await release.promise;
      },
    });
    return { done, release, opts: () => opts as Record<string, (p: unknown) => unknown> };
  }

  it("F7.16 null -> template: nothing known yet means the plugin's own template; once core signals arrive the board text takes over", async () => {
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    const d = openDispatch(plugin);
    await vi.advanceTimersByTimeAsync(sec(95));
    expect(plugin.texts()).toEqual(["処理中...（30秒経過）", "処理中...（90秒経過）"]); // e.g. still waiting in the lane / no signals
    await d.opts().onAgentRunStart?.("run-1" as never);
    await d.opts().onToolStart?.(toolStart("pdf", "c1") as never);
    await vi.advanceTimersByTimeAsync(sec(55)); // t=150
    expect(plugin.texts().at(-1)).toBe("PDFを読み取り中です（経過55秒・全体2分30秒）");
    d.release.resolve();
    await d.done;
  });

  it("F7.16b two dispatches share ONE timer: the most recently started stage is shown; the timer survives the first detach and dies with the last", async () => {
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    const a = openDispatch(plugin);
    await a.opts().onToolStart?.(toolStart("pdf", "a1") as never);
    await a.opts().onItemEvent?.(itemEvent("pdf", "a1", "start", "running") as never);
    await vi.advanceTimersByTimeAsync(sec(20));
    const b = openDispatch(plugin); // same account + to: joins
    expect(plugin.log).toEqual(["started", "joined"]);
    expect(vi.getTimerCount()).toBe(1); // still just the one first-timer
    await vi.advanceTimersByTimeAsync(sec(10)); // t=30: B has no signal yet -> A's stage
    expect(plugin.texts()).toEqual(["PDFを読み取り中です（経過30秒）"]);
    await vi.advanceTimersByTimeAsync(sec(10)); // t=40
    await b.opts().onToolStart?.(toolStart("web_search", "b1") as never);
    await vi.advanceTimersByTimeAsync(sec(50)); // t=90: B's stage started later than A's
    expect(plugin.texts().at(-1)).toBe("Web検索中です（経過50秒・全体1分30秒）");
    a.release.resolve();
    await a.done; // first dispatch ends; timer continues for B
    expect(plugin.intervalAckStates.get(KEY)?.activeDispatches).toBe(1);
    expect(board.has(KEY)).toBe(true);
    await vi.advanceTimersByTimeAsync(sec(60)); // t=150
    expect(plugin.texts().at(-1)).toBe("Web検索中です（経過1分50秒・全体2分30秒）");
    b.release.resolve();
    await b.done;
    expect(plugin.intervalAckStates.size).toBe(0);
    expect(board.has(KEY)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const count = plugin.pushed.length;
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(plugin.pushed).toHaveLength(count); // nothing after cleanup
    expect(leaksIn(plugin.texts())).toEqual([]);
  });

  it("F7.16c queued message: core runs it with the options of the dispatch that queued it (agent-runner-run.ts creates the followup runner with its own opts), usually after that dispatch has ended -> its callbacks reach a live dispatch of the conversation, else they are dropped", async () => {
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    const live = openDispatch(plugin); // e.g. the first message's dispatch, still delivering
    const queuer = openDispatch(plugin); // the second message: returns early, its dispatch ends before the queued run starts
    const queuerOpts = queuer.opts(); // what the queued run keeps calling
    queuer.release.resolve();
    await queuer.done;
    await queuerOpts.onAgentRunStart?.("run-2" as never);
    await queuerOpts.onToolStart?.(toolStart("memory_search", "q1") as never);
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(plugin.texts()).toEqual(["記憶を検索中です（経過30秒）"]);
    live.release.resolve();
    await live.done;
    expect(board.has(KEY)).toBe(false);
    await queuerOpts.onToolStart?.(toolStart("pdf", "q2") as never); // nobody left: dropped, no throw
    expect(board.render(KEY, Date.now())).toBeNull();
  });

  it("F7.16d scope direct only (prod): a group dispatch gets no timer, no attachment and no replyOptions -> core is untouched", async () => {
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board, scope: "direct" });
    const g = openDispatch(plugin, { to: "lineworks:channel:room1", isGroup: true });
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(g.opts()).toBeUndefined();
    expect(plugin.texts()).toEqual([]);
    expect(board.has(`${ACCOUNT}\u0000lineworks:channel:room1`)).toBe(false);
    expect(plugin.intervalAckStates.size).toBe(0);
    g.release.resolve();
    await g.done;
  });

  it("F7.16e hostile payloads (paths, URLs, commands, tokens in plan text, tool names, titles, args, errors) never reach the pushed text", async () => {
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    const d = openDispatch(plugin);
    const o = d.opts();
    await o.onAgentRunStart?.("run-1" as never);
    await o.onPlanUpdate?.({
      phase: "update",
      steps: [{ step: `${leaky.url} から ${leaky.path} を集計`, status: "in_progress" }],
    } as never);
    await o.onToolStart?.(toolStart(leaky.command, "h1") as never);
    await o.onItemEvent?.(itemEvent("exec", "h2", "start", "running") as never);
    await o.onItemEvent?.(
      itemEvent("exec", "h2", "end", "failed", { error: leaky.command }) as never,
    );
    await o.onItemEvent?.(
      itemEvent("pdf", "h3", "end", "failed", { error: FAILURE.message }) as never,
    );
    await vi.advanceTimersByTimeAsync(sec(95));
    expect(plugin.texts().length).toBe(2);
    expect(leaksIn(plugin.texts())).toEqual([]);
    expect(plugin.texts()[0]).toContain("手順1/1「（URL） から （パス） を集計」");
    d.release.resolve();
    await d.done;
  });

  it("F7.16f a finished run shows nothing to the timer (the final reply is about to go out): null -> template", async () => {
    const board = boardRef.createProgressBoard();
    const plugin = createPluginReplica({ board });
    const d = openDispatch(plugin);
    await d.opts().onToolStart?.(toolStart("pdf", "c1") as never);
    await d.opts().onAgentRunTerminalOutcome?.("completed" as never);
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(plugin.texts()).toEqual(["処理中...（30秒経過）"]);
    d.release.resolve();
    await d.done;
  });
});
