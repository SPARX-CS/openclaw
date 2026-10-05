// F7 (plugin -> core read point): core.channel.inbound.dispatchReply IS dispatchAssembledChannelTurn
// (src/plugins/runtime/runtime-channel.ts: `dispatchReply: dispatchAssembledChannelTurn`). The in-house LINE WORKS plugin calls it with
// dispatchReplyWithBufferedBlockDispatcher; this test runs the REAL dispatchAssembledChannelTurn with a fake buffered dispatcher and
// shows that `replyOptions` (ChannelTurnReplyOptions) reaches that dispatcher: every progress callback by identity, except
// onAgentRunStart which core wraps (to record the run id) and chains to the plugin's callback. No core change is needed.
// (What dispatchReplyFromConfig then does with the callbacks, i.e. the verbose gate, is in f7-text-channel-dispatch.test.ts.)
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchAssembledChannelTurn } from "../../src/channels/turn/lifecycle.js";
import { boardRef, toolStart } from "./f7-text-channel-progress.support.js";

const KEY = "acct\u0000lineworks:user:u1";
const FORWARDED_AS_IS = [
  "onAgentRunTerminalOutcome",
  "onToolStart",
  "onItemEvent",
  "onCommandOutput",
  "onPlanUpdate",
  "onApprovalEvent",
  "onCompactionStart",
  "onCompactionEnd",
] as const;

describe("F7.19 dispatchReply (= dispatchAssembledChannelTurn) forwards the plugin's replyOptions", () => {
  it("F7.19 the board's callbacks reach the buffered dispatcher; onAgentRunStart is wrapped and chained; no core change needed", async () => {
    const board = boardRef.createProgressBoard();
    const progress = board.attach(KEY);
    let received: Record<string, unknown> | undefined;
    const bufferedDispatcher = vi.fn(async (params: { replyOptions?: Record<string, unknown> }) => {
      received = params.replyOptions;
      // what core's run does next: signal the run start, then a tool
      (received?.onAgentRunStart as (id: string) => void)("run-1");
      (received?.onToolStart as (p: unknown) => void)(toolStart("pdf", "c1"));
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    try {
      await dispatchAssembledChannelTurn({
        cfg: {},
        agentId: "main",
        channel: "lineworks",
        accountId: "default",
        routeSessionKey: "agent:main:lineworks:direct:u1",
        storePath: path.join(os.tmpdir(), "f7-dispatch-reply-sessions.json"),
        ctxPayload: {
          Body: "hi",
          SessionKey: "agent:main:lineworks:direct:u1",
          Provider: "lineworks",
          ChatType: "direct",
          From: "lineworks:u1",
          To: "lineworks:u1",
          MessageSid: "m1",
        } as never,
        recordInboundSession: (async () => {}) as never,
        dispatchReplyWithBufferedBlockDispatcher: bufferedDispatcher as never,
        delivery: { deliver: async () => {} },
        replyPipeline: {}, // as the plugin passes it: core adds onModelSelected
        replyOptions: progress.replyOptions as never,
      } as never);
      expect(bufferedDispatcher).toHaveBeenCalledTimes(1);
      expect(received?.suppressDefaultToolProgressMessages).toBe(true);
      for (const name of FORWARDED_AS_IS) {
        expect(received?.[name], name).toBe(
          (progress.replyOptions as Record<string, unknown>)[name],
        );
      }
      expect(received?.onAgentRunStart).not.toBe(progress.replyOptions.onAgentRunStart); // wrapped by core ...
      expect(board.render(KEY, Date.now() + 5_000)).toMatch(
        /^PDFを読み取り中です（経過[0-9]+秒）$/,
      ); // ... and chained: the board saw run start + tool
    } finally {
      progress.detach();
    }
    expect(board.has(KEY)).toBe(false);
  });

  it("F7.19b without replyOptions (today's plugin) core simply gets none of the board's callbacks: the edit is purely additive", async () => {
    let received: Record<string, unknown> | undefined;
    await dispatchAssembledChannelTurn({
      cfg: {},
      agentId: "main",
      channel: "lineworks",
      accountId: "default",
      routeSessionKey: "agent:main:lineworks:direct:u1",
      storePath: path.join(os.tmpdir(), "f7-dispatch-reply-sessions.json"),
      ctxPayload: {
        Body: "hi",
        SessionKey: "agent:main:lineworks:direct:u1",
        Provider: "lineworks",
        ChatType: "direct",
        From: "lineworks:u1",
        To: "lineworks:u1",
        MessageSid: "m2",
      } as never,
      recordInboundSession: (async () => {}) as never,
      dispatchReplyWithBufferedBlockDispatcher: (async (params: {
        replyOptions?: Record<string, unknown>;
      }) => {
        received = params.replyOptions;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }) as never,
      delivery: { deliver: async () => {} },
      replyPipeline: {},
    } as never);
    expect(received?.onToolStart).toBeUndefined();
    expect(received?.suppressDefaultToolProgressMessages).toBeUndefined();
  });
});
