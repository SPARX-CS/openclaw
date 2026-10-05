// F7 (dispatch gate): are the progress callbacks actually delivered to a plugin through the REAL
// dispatchReplyFromConfig (src/auto-reply/reply/dispatch-from-config*.ts), with verbose OFF (the customer-safe default)?
//
// Finding this file pins down: core forwards onToolStart / onItemEvent / onCommandOutput / onPlanUpdate / onCompactionStart
// only when tool summaries are visible (verbose on/full) OR the plugin passes `suppressDefaultToolProgressMessages: true`
// (dispatch-from-config.prepare-execution.ts: shouldForwardProgressCallback). The reference reporter sets that flag in its
// replyOptions, which delivers the callbacks while keeping the default English "🛠️ Exec: …" tool texts away from the customer.
// The reply resolver is a fake (it plays the model run and calls the options core handed it); everything between the
// plugin's replyOptions and the resolver is the real dispatch code. Fake timers; no network; no real channel.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDispatcher,
  emptyConfig,
  sessionStoreMocks,
} from "../../src/auto-reply/reply/dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "../../src/auto-reply/reply/dispatch-from-config.test-harness.js";
import { buildTestCtx } from "../../src/auto-reply/reply/test-ctx.js";
import {
  commandOutputEnd,
  createRig,
  itemEvent,
  leaksIn,
  leaky,
  toolStart,
} from "./f7-text-channel-progress.support.js";

beforeAll(globalBeforeAll0);

const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;

function directCtx() {
  return buildTestCtx({
    Provider: "telegram",
    ChatType: "direct",
    SessionKey: "agent:main:telegram:direct:U1",
  });
}

beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
  sessionStoreMocks.currentEntry = { sessionId: "session", updatedAt: 0, verboseLevel: "off" };
  vi.useFakeTimers({ now: 1_000_000, toFake: [...FAKE_TIMERS] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Plays one model run through the real dispatch: tool, a failing tool, a plan, the English tool texts core would show under /verbose. */
async function runThroughDispatch(
  replyOptions: Record<string, unknown>,
  rig: ReturnType<typeof createRig>,
) {
  const dispatcher = createDispatcher();
  const seen: string[] = [];
  await dispatchReplyFromConfig({
    ctx: directCtx(),
    cfg: emptyConfig,
    dispatcher,
    replyOptions: replyOptions as never,
    replyResolver: async (_ctx, opts) => {
      await opts?.onPlanUpdate?.({
        phase: "update",
        steps: [{ step: "請求書を読む", status: "in_progress" }],
      });
      await opts?.onToolStart?.(toolStart("pdf", "c1"));
      await opts?.onItemEvent?.(itemEvent("pdf", "c1", "start", "running"));
      await opts?.onToolResult?.({ text: `🛠️ PDF: ${leaky.path}` }); // what /verbose shows the customer
      await vi.advanceTimersByTimeAsync(1_500);
      seen.push(...rig.texts());
      await opts?.onItemEvent?.(itemEvent("pdf", "c1", "end", "failed"));
      await opts?.onCommandOutput?.(commandOutputEnd("e1", 2, "failed"));
      await opts?.onCompactionStart?.();
      opts?.onAgentRunTerminalOutcome?.("completed");
      return { text: "完了しました。" };
    },
  });
  return { dispatcher, seenBeforeEnd: seen };
}

describe("F7.12 dispatch gate with verbose OFF (customer-safe default)", () => {
  it("F7.12 with the reporter's replyOptions (suppressDefaultToolProgressMessages:true) the callbacks arrive and no English tool text is delivered", async () => {
    const rig = createRig();
    rig.reporter.start();
    const { dispatcher, seenBeforeEnd } = await runThroughDispatch({ ...rig.o }, rig);
    expect(seenBeforeEnd).toEqual(["PDFを読み取り中です（手順1/1「請求書を読む」）。"]);
    expect(rig.texts().at(-1)).toBe(
      "手順1/1「請求書を読む」の途中、PDFの読み取りで失敗しました。別の方法を試します。",
    );
    expect(vi.mocked(dispatcher.sendToolResult)).not.toHaveBeenCalled(); // no "🛠️ PDF: /home/…" text to the customer
    expect(vi.mocked(dispatcher.sendFinalReply)).toHaveBeenCalledWith({ text: "完了しました。" });
    expect(leaksIn(rig.texts())).toEqual([]);
    rig.reporter.stop();
  });

  it("F7.12b (record) WITHOUT suppressDefaultToolProgressMessages the progress callbacks are NOT delivered at all (verbose off) -> the plugin would show nothing", async () => {
    const rig = createRig();
    rig.reporter.start();
    const { suppressDefaultToolProgressMessages: _flag, ...withoutFlag } = rig.o;
    const { dispatcher } = await runThroughDispatch(withoutFlag, rig);
    expect(rig.texts()).toEqual(["考え中です。"]); // only the reporter's own gate placeholder: no tool / plan / failure signal got through
    expect(vi.mocked(dispatcher.sendToolResult)).not.toHaveBeenCalled();
    rig.reporter.stop();
  });

  it("F7.12c the terminal outcome (a failed run) reaches the reporter through the dispatch lifecycle wrapper", async () => {
    const rig = createRig();
    rig.reporter.start();
    const dispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: directCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { ...rig.o } as never,
      replyResolver: async (_ctx, opts) => {
        await opts?.onItemEvent?.(itemEvent("web_fetch", "c1", "end", "failed"));
        opts?.onAgentRunTerminalOutcome?.("failed");
        return { text: "⚠️ Something went wrong while processing your request.", isError: true };
      },
    });
    expect(rig.texts()).toEqual([
      "Webページの取得で失敗しました。別の方法を試します。",
      "処理を完了できませんでした。失敗した箇所: Webページの取得。依頼の内容やファイル・URLをご確認のうえ、もう一度お試しください。",
    ]);
    expect(rig.reporter.terminalFailureSent).toBe(true);
    rig.reporter.stop();
  });
});

describe("F7.13 (record) why verbose must stay off for customers", () => {
  it.each(["on", "full"])(
    "F7.13 verbose=%s: core delivers the English tool text with the raw path to the customer",
    async (level) => {
      sessionStoreMocks.currentEntry = { sessionId: "session", updatedAt: 0, verboseLevel: level };
      const rig = createRig();
      rig.reporter.start();
      const { dispatcher } = await runThroughDispatch(
        { ...rig.o, suppressDefaultToolProgressMessages: undefined },
        rig,
      );
      const delivered = vi.mocked(dispatcher.sendToolResult).mock.calls.map(([p]) => p.text ?? "");
      expect(delivered.some((t) => t.includes("/home/sparx"))).toBe(true); // the leak the reporter exists to avoid
      rig.reporter.stop();
    },
  );
});
