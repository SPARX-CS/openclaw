import { dispatchInboundMessageWithBufferedDispatcher } from "../../src/auto-reply/dispatch.js";
import { buildTestCtx } from "../../src/auto-reply/reply/test-ctx.js";
// Shared fixtures for the F3 acceptance (same person sends two messages a few seconds apart).
//
// Seam: dispatchInboundMessageWithBufferedDispatcher (the dispatcher that
// `dispatchReplyWithBufferedBlockDispatcher` / the channel-turn lifecycle use) with an injected
// `dispatchReplyFromConfig` (no vi.mock needed; the parameter exists in both trees).
// The injected function plays "the agent turn" of one inbound message; everything between it and
// the `deliver` callback (dispatcher, FIFO lease, receipts) is the real production code.
import { createDeferred } from "../helpers/promise.js";

export { createDeferred };

/** Stand-in channel id (the LINE WORKS plugin is not used). */
export const CHANNEL = "testchannel";
export const PERSON = "testchannel:person-1";

export type Delivery = { kind: string; text: string | undefined };

export function buildCtx(overrides: Record<string, unknown> = {}) {
  return buildTestCtx({
    SessionKey: "agent:main:testchannel:direct:person-1",
    AccountId: "default",
    From: PERSON,
    To: "testchannel:bot",
    ChatType: "direct",
    Provider: CHANNEL,
    Surface: CHANNEL,
    OriginatingChannel: CHANNEL,
    OriginatingTo: PERSON,
    ...overrides,
  } as never);
}

export function queuedFinalResult() {
  return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
}

export function noReplyResult() {
  return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
}

type TurnFn = (params: {
  ctx: { MessageSid?: string };
  dispatcher: { sendFinalReply: (payload: { text?: string }) => unknown };
}) => Promise<unknown>;

/**
 * Dispatch one inbound message the way a channel plugin does.
 * `turn` is the stand-in for the agent run; `deliver` records what the user would see.
 */
export function dispatchMessage(params: {
  ctx: ReturnType<typeof buildCtx>;
  turn: TurnFn;
  deliveries: Delivery[];
  deliver?: (payload: { text?: string }, info: { kind: string }) => Promise<unknown>;
  cfg?: Record<string, unknown>;
  dispatcherOptions?: Record<string, unknown>;
}) {
  return dispatchInboundMessageWithBufferedDispatcher({
    ctx: params.ctx,
    cfg: (params.cfg ?? {}) as never,
    dispatchReplyFromConfig: params.turn as never,
    dispatcherOptions: {
      ...params.dispatcherOptions,
      deliver:
        params.deliver ??
        (async (payload: { text?: string }, info: { kind: string }) => {
          params.deliveries.push({ kind: info.kind, text: payload.text });
        }),
    },
  } as never);
}

/** Final-delivery counters of a settled dispatch (what the 7.1-2 symptom "no queued reply payloads" read). */
export function finalReceipt(result: unknown) {
  const r = result as {
    queuedFinal?: boolean;
    counts?: { final?: number };
    settledReceipt?: {
      anyVisibleDelivered?: boolean;
      counts?: { final?: Record<string, number> };
    };
  };
  return {
    queuedFinal: r.queuedFinal,
    finalCount: r.counts?.final,
    delivered: r.settledReceipt?.counts?.final?.delivered,
    cancelled: r.settledReceipt?.counts?.final?.cancelled,
    failedBeforeSend: r.settledReceipt?.counts?.final?.failedBeforeSend,
    failedAfterSend: r.settledReceipt?.counts?.final?.failedAfterSend,
    anyVisibleDelivered: r.settledReceipt?.anyVisibleDelivered,
  };
}
