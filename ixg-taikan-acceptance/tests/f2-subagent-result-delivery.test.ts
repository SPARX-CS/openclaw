// F2: a child task (here an image-producing subagent) finishes, but its result never reaches the
// requester's conversation. In production the child finished, the requester session could not be
// woken, the result stayed "suspended delivery pending", and a week later the registry logged
// `subagent suspended delivery discarded reason=expired`. The user got nothing.
//
// DESIRED behavior asserted here (owner's order, in this order):
//   (1) when the requester cannot be woken, the child's result (text AND media) is delivered DIRECTLY to
//       the requester conversation's destination (channel / to / accountId of the run's requesterOrigin)
//       and the delivery is recorded in the requester session's transcript - early (as soon as the
//       settle-wake attempts are exhausted), not at 7 days;
//   (2) only when that direct delivery is impossible or fails, the user is told in a short plain Japanese
//       sentence which request it was, that the child finished but delivering the result failed, why, and
//       what to do next (not just "send again");
//   (3) the 7-day expiry is never silent: before it, (1) or (2) has happened - exactly once (no duplicate
//       result, no duplicate notice) across settle-wake exhaustion, the sweeper, retries and a restart; the
//       discard path is a backstop (it tries (1) then (2) once more if nothing has reached the user).
//   No timeout or retry window is changed (slow is not failed): F2.4 still records the existing windows.
//
// What counts as a "direct delivery" (decided once, used by F2.2 / F2.2b / F2.3 / F2.5 / F2.6):
//   a message sent DIRECTLY toward the user's conversation, without needing the requester agent to wake
//   and compose it: infra/outbound `sendMessage` (the mocked network edge; its effective payload, i.e. text
//   and the MEDIA: attachments the real outbound payload plan extracts, and its transcript `mirror` request
//   are recorded), `deliverOutboundPayloads`, a gateway `send`-style call, or
//   `GatewayRecoveryRuntime.sendRecoveryNotice`; a notice that only goes to the requester session's
//   transcript (no destination at all) is recorded separately.
//   NOT counted: (a) the `kind: "systemEvent"` that blockSubagentCompletionDelivery queues for the
//   requester session - it is addressed to the requester AGENT and only reaches the user if that same
//   requester can be woken and chooses to relay it, which is exactly what failed (recorded in the
//   F2.3 (record) case); (b) the `subagent_ended` hook with sendFarewell - it only unbinds thread
//   bindings (Discord/Matrix/Feishu) and feeds workboard; (c) logs.
//
// The cases run the REAL registry / announce / requester-settle-wake / sweeper code under fake timers
// (the product flow, in the style of subagent-registry.requester-wake.e2e.test.ts). Only the network
// edge is faked: callGateway (requester agent turns), outbound send, and the session store. No real keys,
// no network, no customer data; the channel is a stand-in id and LINE WORKS' plugin is not used.
// Six requesters run side by side in one registry (which keeps B's slow worker start-up to a single
// cold start):
//   reachable     - can be woken (F2.1);
//   lost          - its agent turn can never be started; the direct send works (F2.2, F2.3, F2.5, F2.6);
//   abandoned     - its session is "abandoned" so the announce path refuses to wake it (F2.2b);
//   undeliverable - cannot be woken AND the direct send of the result (it carries media) is rejected, a
//                   plain-text notice gets through (F2.3 notice);
//   noroute       - cannot be woken and has no destination at all: the notice goes to the session record;
//   outage        - cannot be woken and every send is rejected until just before the 7-day expiry, so only
//                   the retries and the discard-time backstop can serve it (F2.6).
// A simulated gateway restart (registry torn down and restored from its persisted rows) happens on day 2.
//
// Version notes (A = v2026.9.6+patches, B = v2026.9.7): the same file runs on both.
//   * B persists registry rows through a SQLite worker owned by a "host broker" that refuses to start
//     inside a vitest thread (`isMainThread === false`), and the acceptance runner uses the thread pool.
//     On trees that contain that async writer we make `node:worker_threads.isMainThread` read true for
//     the code under test (the broker then spawns its real workers from this thread). A's registry
//     writes are synchronous and need no shim.
//   * Real worker I/O is not driven by fake timers, and B's worker-pool tasks arm fake-timer timeouts
//     (a worker that is still starting "times out" as soon as fake time moves). The driver therefore
//     interleaves real 4ms ticks with fake-time steps and does not advance fake time while a
//     worker-pool task is in flight or the observable state is still changing.
import { readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSubagentRunParams } from "../../src/agents/subagent-test-fixtures.test-helpers.js";
import { testing as announceDeliveryTesting } from "../../src/agents/subagents/announce/subagent-announce-delivery.test-support.js";
import { testing as announceOutputTesting } from "../../src/agents/subagents/announce/subagent-announce-output.test-support.js";
import { announceTesting } from "../../src/agents/subagents/announce/subagent-announce-overrides.test-support.js";
import { ANNOUNCE_COMPLETION_HARD_EXPIRY_MS } from "../../src/agents/subagents/registry/subagent-registry-helpers.js";
import { resolveSuspendedDeliveryExpiryMs } from "../../src/agents/subagents/registry/subagent-registry-suspended-delivery.js";
import * as registry from "../../src/agents/subagents/registry/subagent-registry.test-helpers.js";
import { getRuntimeConfig } from "../../src/config/config.js";
import { replaceSessionEntry } from "../../src/config/sessions/session-accessor.js";
import { callGateway } from "../../src/gateway/call.js";
import { onAgentEvent } from "../../src/infra/agent-events.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../src/infra/outbound/payloads.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";

// ---- shared, hoisted state (read by the vi.mock factories below) -------------------------------
const h = vi.hoisted(() => ({
  sessionStore: {} as Record<string, unknown>,
  sessionStorePath: "",
  logs: [] as Array<{
    at: number;
    subsystem: string;
    level: string;
    message: string;
    meta?: unknown;
  }>,
  hookCalls: [] as Array<{ at: number; event: Record<string, unknown> }>,
  outbound: [] as Array<{ at: number; via: string; payload: unknown }>,
  /** Sends the faked network edge refused (they never reached the user). */
  rejected: [] as Array<{ at: number; via: string; payload: unknown }>,
  /** Writes to a requester session's transcript: sendMessage `mirror` requests and direct appends. */
  transcript: [] as Array<{
    at: number;
    via: string;
    sessionKey: string;
    text: string;
    mediaUrls: string[];
    idempotencyKey?: string;
  }>,
  /** Every send to the "outage" requester fails until this instant (epoch ms); 0 = no outage. */
  outageEndsAt: 0,
  lifecycleHandler: undefined as undefined | ((event: unknown) => void),
}));

// Real timers/clocks, captured before fake timers are installed.
const realSetTimeout = globalThis.setTimeout;
const realPerfNow = performance.now.bind(performance);
const realTick = (ms = 4) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:worker_threads")>();
  const { readFileSync: read } = await import("node:fs");
  let needsHostBrokerShim = false;
  try {
    needsHostBrokerShim = read(
      new URL("../../src/agents/subagents/registry/subagent-registry-state.ts", import.meta.url),
      "utf8",
    ).includes("persistSubagentRunsToDiskAsyncOrThrow");
  } catch {
    // Unknown layout: leave the real value alone.
  }
  return needsHostBrokerShim ? { ...original, isMainThread: true } : original;
});
vi.mock("../../src/logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (subsystem: string) => {
      const real = original.createSubsystemLogger(subsystem);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "warn" || prop === "error" || prop === "info") {
            return (message: string, meta?: unknown) => {
              h.logs.push({ at: Date.now(), subsystem, level: String(prop), message, meta });
              return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]?.(
                message,
                meta,
              );
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});
vi.mock("../../src/config/config.js", { spy: true });
vi.mock("../../src/gateway/call.js", { spy: true });
vi.mock("../../src/infra/agent-events.js", { spy: true });
vi.mock("../../src/agents/runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../src/plugins/registry-empty.js");
  return { loadAgentRuntimePluginRegistryHandle: vi.fn(() => createEmptyPluginRegistry()) };
});
vi.mock("../../src/config/sessions.js", async () => ({
  ...(await import("../../src/config/sessions/targets.js")),
  ...(await import("../../src/config/sessions/main-session.js")),
  loadSessionStore: vi.fn(() => h.sessionStore),
  resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveSessionStorePathCore: () => h.sessionStorePath,
  resolveMainSessionKey: () => "agent:main:main",
  updateSessionStore: vi.fn(),
}));
vi.mock("../../src/config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/sessions/session-accessor.js")>()),
  loadSessionEntry: (scope: { sessionKey: string }) => h.sessionStore[scope.sessionKey],
  patchSessionEntryCore: async (
    scope: { sessionKey: string },
    update: (entry: unknown, ctx: unknown) => Promise<unknown>,
    options: {
      shouldCommit?: () => boolean;
      assertCommitAllowed?: () => void;
      replaceEntry?: boolean;
    } = {},
  ) => {
    const entry = h.sessionStore[scope.sessionKey] as Record<string, unknown> | undefined;
    if (!entry) {
      return null;
    }
    const patch = await update(entry, { existingEntry: { ...entry } });
    if (patch === null || options.shouldCommit?.() === false) {
      return entry;
    }
    options.assertCommitAllowed?.();
    const updated = options.replaceEntry ? patch : { ...entry, ...(patch as object) };
    h.sessionStore[scope.sessionKey] = updated;
    return updated;
  },
  listSessionEntriesReadOnly: () =>
    Object.entries(h.sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
}));
vi.mock("../../src/plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (name: string) => name === "subagent_ended",
    runSubagentEnded: async (event: Record<string, unknown>) => {
      h.hookCalls.push({ at: Date.now(), event });
    },
  })),
}));
vi.mock("../../src/browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));
vi.mock("../../src/agents/subagents/spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));
// Every direct-to-user send path is recorded here and made harmless. `sendMessage` also computes what the
// real outbound payload plan would deliver (text plus the MEDIA: attachments it extracts) and what the
// real `mirror` request would write into the requester session's transcript.
vi.mock("../../src/infra/outbound/message.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infra/outbound/message.js")>()),
  sendMessage: vi.fn(async (payload: Record<string, unknown>) => {
    const projection = projectOutboundPayloadPlanForMirror(
      createOutboundPayloadPlan([
        {
          text: payload.content as string | undefined,
          mediaUrl: payload.mediaUrl as string | undefined,
          mediaUrls: payload.mediaUrls as string[] | undefined,
        },
      ]),
    );
    const effective = { text: projection.text, mediaUrls: projection.mediaUrls };
    const entry = { at: Date.now(), via: "sendMessage", payload: { ...payload, effective } };
    const to = String(payload.to);
    if (to === "user-4" && effective.mediaUrls.length > 0) {
      // "undeliverable": the channel refuses the attachment; a plain-text message is fine.
      h.rejected.push(entry);
      throw new Error("channel rejected the attachment");
    }
    if (to === "user-6" && Date.now() < h.outageEndsAt) {
      h.rejected.push(entry);
      throw new Error("channel unavailable");
    }
    h.outbound.push(entry);
    const mirror = payload.mirror as
      | { sessionKey: string; idempotencyKey?: string; text?: string; mediaUrls?: string[] }
      | undefined;
    if (mirror) {
      h.transcript.push({
        at: Date.now(),
        via: "sendMessage.mirror",
        sessionKey: mirror.sessionKey,
        text: effective.text,
        mediaUrls: effective.mediaUrls,
        idempotencyKey: mirror.idempotencyKey,
      });
    }
    await (payload.onDeliveryResult as undefined | ((result: unknown) => unknown))?.({
      messageId: "m-1",
    });
    return {
      channel: "discord",
      to,
      via: "direct",
      mediaUrl: effective.mediaUrls[0] ?? null,
      result: { messageId: "m-1" },
    };
  }),
}));
// A notice with nowhere to go is written to the requester session's transcript instead.
vi.mock("../../src/config/sessions/transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/sessions/transcript.js")>()),
  appendAssistantMessageToSessionTranscript: vi.fn(
    async (params: { sessionKey: string; text?: string; idempotencyKey?: string }) => {
      h.transcript.push({
        at: Date.now(),
        via: "appendAssistantMessage",
        sessionKey: params.sessionKey,
        text: params.text ?? "",
        mediaUrls: [],
        idempotencyKey: params.idempotencyKey,
      });
      return { ok: true as const };
    },
  ),
}));
vi.mock("../../src/infra/outbound/deliver.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/infra/outbound/deliver.js")>();
  return {
    ...original,
    ...("deliverOutboundPayloads" in original
      ? {
          deliverOutboundPayloads: vi.fn(async (payload: unknown) => {
            h.outbound.push({ at: Date.now(), via: "deliverOutboundPayloads", payload });
            return [];
          }),
        }
      : {}),
  };
});

// ---- scenario constants -------------------------------------------------------------------------
const START = Date.parse("2026-10-05T00:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IMAGE_PATH = "/tmp/ixg-f2-cat.png";
const RESULT_TEXT = `Generated 1 image.\nMEDIA:${IMAGE_PATH}`;
const REACHABLE = {
  runId: "run-f2-reachable",
  child: "agent:main:subagent:f2-reachable",
  requester: "agent:main:main",
  to: "user-1",
};
/** Its agent turn can never be started: the requester "could not be woken". */
const LOST = {
  runId: "run-f2-lost",
  child: "agent:main:subagent:f2-lost",
  requester: "agent:main:discord:dm:user-2",
  to: "user-2",
};
/** Its requester session is "abandoned" (timed out): the announce path refuses to wake it at all. */
const ABANDONED = {
  runId: "run-f2-abandoned",
  child: "agent:main:subagent:f2-abandoned",
  requester: "agent:main:discord:dm:user-3",
  to: "user-3",
};
/** Cannot be woken; the direct send of the result (it carries media) is rejected, plain text gets through. */
const UNDELIVERABLE = {
  runId: "run-f2-undeliverable",
  child: "agent:main:subagent:f2-undeliverable",
  requester: "agent:main:discord:dm:user-4",
  to: "user-4",
};
/** Cannot be woken and its conversation has no destination (no requesterOrigin, no session route). */
const NOROUTE = {
  runId: "run-f2-noroute",
  child: "agent:main:subagent:f2-noroute",
  requester: "agent:main:discord:dm:user-5",
  to: "user-5",
};
/** Cannot be woken; every send is rejected until shortly before the 7-day expiry. */
const OUTAGE = {
  runId: "run-f2-outage",
  child: "agent:main:subagent:f2-outage",
  requester: "agent:main:discord:dm:user-6",
  to: "user-6",
};
const SPECS = {
  reachable: REACHABLE,
  lost: LOST,
  abandoned: ABANDONED,
  undeliverable: UNDELIVERABLE,
  noroute: NOROUTE,
  outage: OUTAGE,
} as const;
type SpecName = keyof typeof SPECS;
/** Requesters whose agent turn can never be started, whichever way the product tries. */
const UNWAKEABLE = new Set(
  [LOST, ABANDONED, UNDELIVERABLE, NOROUTE, OUTAGE].map((spec) => spec.requester),
);
const GATEWAY_INTERNAL_METHODS = new Set([
  "agent",
  "agent.wait",
  "chat.history",
  "chat.abort",
  "sessions.delete",
  "sessions.get",
  "sessions.list",
  "sessions.patch",
  "sessions.resolve",
]);
// Plain-language "it failed / was not delivered" wording (English or Japanese).
const FAILURE_WORDING =
  /(could ?n[o']t|couldn['’]t|can['’]?t|cannot|unable|failed|not (?:be )?delivered|never (?:arrived|reached)|did ?n[o']t (?:arrive|reach|get)|lost|expired|dropped|届(?:か|け)|失敗|できません|できませんでした)/i;

type Snapshot = {
  atMs: number;
  deliveryStatus?: string;
  suspendedReason?: string;
  discardReason?: string;
  announceAttempts?: number;
  /** Minutes after the child finished at which the row was suspended / discarded. */
  suspendedAtMin?: number;
  discardedAtMin?: number;
  hasRequesterSettleWake: boolean;
  /** The persisted idempotency markers of the last-resort delivery (what survives a restart). */
  fallback?: { resultSent: boolean; noticeSent: boolean; attempts?: number };
};
type AgentCall = {
  at: number;
  sessionKey?: string;
  idempotencyKey?: string;
  params: Record<string, unknown>;
};
type Observation = {
  completedAt: number;
  agentCalls: AgentCall[];
  /** Gateway methods that are not agent turns / reads (candidates for a direct send). */
  otherGatewayCalls: Array<{ at: number; method: string; params: unknown }>;
  outbound: Array<{ at: number; via: string; payload: unknown }>;
  /** Sends the faked network edge refused. */
  rejected: Array<{ at: number; via: string; payload: unknown }>;
  transcript: typeof h.transcript;
  /** Direct sends per run, counted just before and just after the simulated restart (day 2). */
  restart: { before: Record<string, number>; after: Record<string, number> };
  outageEndsAt: number;
  hooks: Array<{ at: number; event: Record<string, unknown> }>;
  logs: Array<{ at: number; subsystem: string; level: string; message: string; meta?: unknown }>;
  queuedSystemEvents: string[];
  /** Snapshots of each run's delivery state at named checkpoints. */
  runs: Record<SpecName, Record<string, Snapshot>>;
  mediaHandoff: {
    result?: Record<string, unknown>;
    queued: Array<Record<string, unknown>>;
    error?: string;
  };
};

/** Evidence for the report: vitest's JSON reporter drops console output, so write a small file. */
const recordFile = new URL("./f2-record.json", import.meta.url);
function record(key: string, value: unknown) {
  try {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(recordFile, "utf8")) as Record<string, unknown>;
    } catch {
      // first write
    }
    current[key] = value;
    writeFileSync(recordFile, JSON.stringify(current, null, 1));
  } catch {
    // evidence only
  }
}

function textOf(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? "";
  } catch {
    return String(payload);
  }
}

type Spec = (typeof SPECS)[SpecName];
/** A send belongs to a run when it names that run's user, requester session, child or run id. */
const mentionsSpec = (text: string, spec: Spec) =>
  [spec.to, spec.requester, spec.runId, spec.child].some((id) => text.includes(id));

/** One direct-to-user send, with the text and media that would actually reach the user. */
type Send = {
  at: number;
  via: string;
  to?: string;
  /** What the user would read (never the idempotency key or other plumbing). */
  text: string;
  mediaUrls: string[];
  payload: unknown;
};
function sendOf(e: { at: number; via: string; payload: unknown }): Send {
  const p = (e.payload ?? {}) as {
    to?: string;
    effective?: { text?: string; mediaUrls?: string[] };
    content?: string;
    text?: string;
  };
  return {
    at: e.at,
    via: e.via,
    to: p.to,
    text: p.effective?.text ?? p.content ?? p.text ?? textOf(e.payload),
    mediaUrls: p.effective?.mediaUrls ?? [],
    payload: e.payload,
  };
}
const toMs = (obs: Observation, minutes: number) => obs.completedAt + minutes * MIN;
/** The user's destination of this run, as the fake network edge saw it. */
const isSendTo = (e: Send, spec: Spec) => e.to === spec.to || mentionsSpec(textOf(e.payload), spec);
const isResultSend = (e: Send) =>
  e.mediaUrls.includes(IMAGE_PATH) && /Generated 1 image/.test(e.text);
const NOTICE_SENTENCE =
  /^「(.+)」の作業は終わりましたが、結果をこの会話へお届けできませんでした（(.+?)）。(.+)$/s;
const isNoticeSend = (e: Send) => NOTICE_SENTENCE.test(e.text);
function directSends(obs: Observation, spec: Spec): Send[] {
  return obs.outbound.map(sendOf).filter((e) => isSendTo(e, spec));
}
/** Direct sends to this run's user that carry the child's result (text + the generated image). */
const resultSends = (obs: Observation, spec: Spec) => directSends(obs, spec).filter(isResultSend);
/** Direct plain-Japanese "finished but could not be delivered" messages, plus session-record-only ones. */
function noticeSends(obs: Observation, spec: Spec) {
  const toUser = directSends(obs, spec).filter(isNoticeSend);
  const toRecord = obs.transcript.filter(
    (w) =>
      w.via === "appendAssistantMessage" &&
      w.sessionKey === spec.requester &&
      NOTICE_SENTENCE.test(w.text),
  );
  return { toUser, toRecord };
}
/** The time the registry discarded a run (the expiry log line), if it did. */
const discardAt = (obs: Observation, spec: Spec) =>
  obs.logs.find(
    (l) =>
      l.message === "subagent suspended delivery discarded" &&
      (l.meta as { runId?: string })?.runId === spec.runId,
  )?.at;

/**
 * Direct-to-user sends that carry plain failure wording (see the header for the definition), optionally
 * limited to one run (the send must name its user / requester / run) and to a time window.
 */
function userVisibleFailureNotices(
  obs: Observation,
  opts?: { fromMs?: number; toMs?: number; spec?: Spec },
) {
  const inWindow = (at: number) =>
    (opts?.fromMs === undefined || at >= opts.fromMs) &&
    (opts?.toMs === undefined || at <= opts.toMs);
  const direct = obs.outbound.map(sendOf);
  const gatewaySends = obs.otherGatewayCalls
    .filter((c) => /send|notice|notify|message/i.test(c.method))
    .map((c) => ({
      at: c.at,
      via: `gateway:${c.method}`,
      text: textOf(c.params),
      mediaUrls: [] as string[],
      payload: c.params,
    }));
  return [...direct, ...gatewaySends].filter(
    (e) =>
      inWindow(e.at) &&
      FAILURE_WORDING.test(e.text) &&
      (opts?.spec === undefined || mentionsSpec(textOf(e.payload), opts.spec)),
  );
}

// ---- the driver: one product flow ---------------------------------------------------------------
async function runScenario(): Promise<Observation> {
  const wallStart = realPerfNow();
  const phase = (label: string) =>
    record(`timingMs:${label}`, Math.round(realPerfNow() - wallStart));
  const testState: OpenClawTestState = await createOpenClawTestState({
    scenario: "minimal",
    applyEnv: true,
  });
  const previousFastEnv = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  // Real module loading is not driven by fake timers. Load what the sweeper imports lazily up front so a
  // cold import cannot stretch a one-minute step into minutes (a harness artifact, not product time).
  // A tree without the last-resort module (the unpatched baseline) simply has nothing to warm.
  const lazyFallbackModule =
    "../../src/agents/subagents/registry/subagent-registry-suspended-fallback.js";
  await import(/* @vite-ignore */ lazyFallbackModule).catch(() => undefined);
  h.logs.length = 0;
  h.hookCalls.length = 0;
  h.outbound.length = 0;
  h.rejected.length = 0;
  h.transcript.length = 0;
  h.outageEndsAt = 0;
  h.lifecycleHandler = undefined;
  h.sessionStorePath = testState.statePath("agents", "main", "sessions", "sessions.json");
  const agentCalls: AgentCall[] = [];
  const otherGatewayCalls: Observation["otherGatewayCalls"] = [];

  const callGatewayMock = vi.fn(
    async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      if (request.method === "chat.history") {
        const isChild = Object.values(SPECS).some(
          (spec) => spec.child === request.params?.sessionKey,
        );
        return {
          messages: isChild ? [{ role: "assistant", content: RESULT_TEXT }] : [],
        };
      }
      if (request.method === "agent") {
        const params = request.params ?? {};
        const sessionKey = params.sessionKey as string | undefined;
        agentCalls.push({
          at: Date.now(),
          sessionKey,
          idempotencyKey: params.idempotencyKey as string | undefined,
          params,
        });
        // None of these requesters can be woken, whichever way the product tries (an abandoned
        // session is refused by the announce path itself, but the settle wake still dispatches a turn).
        if (sessionKey && UNWAKEABLE.has(sessionKey)) {
          throw new Error("requester session could not be woken");
        }
        return {
          result: {
            payloads: [{ text: "Here is your image." }],
            deliveryStatus: { status: "sent", resultCount: 1 },
          },
        };
      }
      if (!GATEWAY_INTERNAL_METHODS.has(request.method)) {
        otherGatewayCalls.push({ at: Date.now(), method: request.method, params: request.params });
      }
      return {};
    },
  );
  const recoveryRuntime = {
    dispatchAgent: (params: unknown, timeoutMs?: number) =>
      callGateway({ method: "agent", params, timeoutMs } as never),
    waitForAgent: (params: unknown, timeoutMs?: number, signal?: AbortSignal) =>
      callGateway({ method: "agent.wait", params, timeoutMs, signal } as never),
    dispatchSessionMethod: (
      method: string,
      params: unknown,
      options?: { timeoutMs?: number; signal?: AbortSignal; assertCurrent?: () => void },
    ) =>
      callGateway({
        method,
        params,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        assertDispatchCurrent: options?.assertCurrent,
      } as never),
    // A fix may tell the user through the recovery-notice channel (existing precedent). Record it.
    sendRecoveryNotice: async (payload: unknown) => {
      h.outbound.push({ at: Date.now(), via: "sendRecoveryNotice", payload });
      return { suppressed: false };
    },
  };
  const gatewayContext = { recoveryRuntime } as {
    recoveryRuntime: unknown;
    resolveGatewayContext?: unknown;
  };
  gatewayContext.resolveGatewayContext = () => gatewayContext;

  const sessionFor = (sessionId: string, to: string) => ({
    sessionId,
    updatedAt: 1,
    // "noroute": a conversation record without any delivery route.
    ...(to === NOROUTE.to
      ? {}
      : {
          delivery: {
            kind: "external",
            route: { channel: "discord", accountId: "default", target: { to } },
            context: { channel: "discord", to, accountId: "default" },
            origin: { provider: "discord", to, accountId: "default" },
          },
        }),
  });
  h.sessionStore = Object.fromEntries(
    Object.entries(SPECS).map(([name, spec]) => [
      spec.requester,
      sessionFor(`sess-${name}`, spec.to),
    ]),
  );
  const loadConfigMock = vi.mocked(getRuntimeConfig);
  loadConfigMock.mockReset().mockReturnValue({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } }, list: [{ id: "main" }] },
    session: { mainKey: "main", scope: "per-sender" },
  } as never);
  vi.mocked(callGateway).mockImplementation(callGatewayMock as unknown as typeof callGateway);
  vi.mocked(onAgentEvent).mockImplementation(((handler: (event: unknown) => void) => {
    h.lifecycleHandler = handler;
    return () => {};
  }) as never);
  for (const requester of Object.values(SPECS).map((spec) => spec.requester)) {
    await replaceSessionEntry(
      { storePath: h.sessionStorePath, sessionKey: requester },
      h.sessionStore[requester] as never,
    );
  }
  vi.useFakeTimers();
  // B's worker-pool tasks arm a (fake-time) timeout when queued; a real worker that is still starting
  // would "time out" the moment fake time moves. Track those timers so the driver can wait them out.
  const liveWorkerTimers = new Set<unknown>();
  {
    const fakeSetTimeout = globalThis.setTimeout;
    const fakeClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (
        typeof ms === "number" &&
        ms >= 1_000 &&
        /worker-task-pool/.test(new Error().stack ?? "")
      ) {
        const handle: unknown = (fakeSetTimeout as (...a: unknown[]) => unknown)(
          (...args: unknown[]) => {
            liveWorkerTimers.delete(handle);
            return fn(...args);
          },
          ms,
          ...rest,
        );
        liveWorkerTimers.add(handle);
        return handle;
      }
      return (fakeSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => {
      liveWorkerTimers.delete(handle);
      return (fakeClearTimeout as (...a: unknown[]) => unknown)(handle);
    }) as typeof clearTimeout;
  }
  announceTesting.setDepsForTest({
    callGateway: callGatewayMock as never,
    getRuntimeConfig: loadConfigMock,
  });
  announceDeliveryTesting.setDepsForTest({
    callGateway: callGatewayMock as never,
    getRuntimeConfig: loadConfigMock,
    loadSessionEntry: ({ sessionKey }: { sessionKey: string }) => h.sessionStore[sessionKey],
    getRequesterSessionActivity: (requesterSessionKey: string) => ({
      sessionId: (h.sessionStore[requesterSessionKey] as { sessionId?: string } | undefined)
        ?.sessionId,
      isActive: false,
    }),
    resolveRequesterSessionAbandonment: (requesterSessionKey: string) =>
      requesterSessionKey === ABANDONED.requester ? "timeout" : undefined,
  } as never);
  announceOutputTesting.setDepsForTest({
    callGateway: callGatewayMock as never,
    getRuntimeConfig: loadConfigMock,
    readSubagentSessionEntry: (_storePath: unknown, sessionKey: string) =>
      h.sessionStore[sessionKey],
    resolveAgentIdFromSessionKey: (key: string | undefined) =>
      key?.match(/^agent:([^:]+)/)?.[1] ?? "main",
    resolveSessionStorePathCore: () => h.sessionStorePath,
  } as never);

  let completedAt = START;
  const runOf = (runId: string) => registry.getSubagentRunByRunId(runId) ?? undefined;
  const snap = (runId: string): Snapshot => {
    const run = runOf(runId);
    return {
      atMs: Date.now() - completedAt,
      deliveryStatus: run?.delivery?.status,
      suspendedReason: run?.delivery?.suspendedReason,
      discardReason: run?.delivery?.discardReason,
      announceAttempts: run?.delivery?.attemptCount,
      ...(typeof run?.delivery?.suspendedAt === "number"
        ? { suspendedAtMin: Math.round(((run.delivery.suspendedAt - completedAt) / MIN) * 10) / 10 }
        : {}),
      ...(typeof run?.delivery?.discardedAt === "number"
        ? { discardedAtMin: Math.round(((run.delivery.discardedAt - completedAt) / MIN) * 10) / 10 }
        : {}),
      hasRequesterSettleWake: run?.requesterSettleWake !== undefined,
      ...(run?.delivery?.fallback
        ? {
            fallback: {
              resultSent: run.delivery.fallback.resultSentAt !== undefined,
              noticeSent: run.delivery.fallback.noticeSentAt !== undefined,
              attempts: run.delivery.fallback.attemptCount,
            },
          }
        : {}),
    };
  };
  const fingerprint = () =>
    JSON.stringify([
      Object.values(SPECS)
        .map((spec) => spec.runId)
        .map((id) => [
          runOf(id)?.delivery?.status,
          runOf(id)?.delivery?.attemptCount,
          runOf(id)?.requesterSettleWake,
          runOf(id)?.execution?.status,
          runOf(id)?.cleanupCompletedAt,
        ]),
      agentCalls.length,
      otherGatewayCalls.length,
      h.outbound.length,
      h.rejected.length,
      h.transcript.length,
      h.hookCalls.length,
      h.logs.length,
    ]);
  /**
   * Let real async I/O finish before fake time moves again: wait until the observable state has been
   * unchanged for a few real ticks and no worker-pool task is in flight.
   */
  const stats = { settles: 0, capped: 0, realMs: 0 };
  const settle = async (rounds = 5, maxRealMs = 20_000) => {
    const started = realPerfNow();
    let quiet = 0;
    let last = fingerprint();
    stats.settles += 1;
    for (;;) {
      if (quiet >= rounds && liveWorkerTimers.size === 0) {
        break;
      }
      if (realPerfNow() - started >= maxRealMs) {
        stats.capped += 1;
        break;
      }
      await realTick(4);
      await vi.advanceTimersByTimeAsync(0);
      const now = fingerprint();
      quiet = now === last ? quiet + 1 : 0;
      last = now;
    }
    stats.realMs += realPerfNow() - started;
  };
  const waitReal = async (predicate: () => boolean, what: string, maxRealMs = 40_000) => {
    const started = realPerfNow();
    while (!predicate()) {
      if (realPerfNow() - started > maxRealMs) {
        throw new Error(
          `harness: timed out waiting for ${what}: ${JSON.stringify({
            runs: Object.fromEntries(Object.entries(SPECS).map(([n, sp]) => [n, snap(sp.runId)])),
            agentCalls: agentCalls.length,
          })}`,
        );
      }
      await realTick(10);
      await vi.advanceTimersByTimeAsync(0);
    }
  };
  const advance = async (totalMs: number, stepMs: number) => {
    for (let spent = 0; spent < totalMs; spent += stepMs) {
      await vi.advanceTimersByTimeAsync(Math.min(stepMs, totalMs - spent));
      await settle();
    }
  };
  /** Await a promise whose real I/O is not covered by fake timers. */
  const pump = async <T>(promise: Promise<T>): Promise<T> => {
    let done = false;
    let value: T | undefined;
    let failure: unknown;
    promise.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        failure = e;
      },
    );
    await waitReal(() => done, "pumped promise");
    if (failure) {
      throw failure;
    }
    return value as T;
  };

  try {
    vi.setSystemTime(START);
    registry.initSubagentRegistry();
    registry.activateSubagentRegistry((() => gatewayContext) as never);
    for (const spec of Object.values(SPECS)) {
      await registry.registerSubagentRun(
        createSubagentRunParams({
          runId: spec.runId,
          childSessionKey: spec.child,
          requesterSessionKey: spec.requester,
          requesterDisplayKey: spec.to,
          requesterOrigin:
            spec === NOROUTE
              ? undefined
              : { channel: "discord", to: spec.to, accountId: "default" },
          requesterAgentId: "main",
          expectsCompletionMessage: true,
          task: "draw a cat",
          label: "cat picture",
        }),
      );
    }
    await waitReal(
      () => Object.values(SPECS).every((spec) => runOf(spec.runId) !== undefined),
      "run registration",
    );
    await settle(8, 15_000);
    phase("registered");
    completedAt = Date.now();
    for (const [index, spec] of Object.values(SPECS).entries()) {
      h.lifecycleHandler?.({
        stream: "lifecycle",
        runId: spec.runId,
        seq: index + 1,
        ts: completedAt,
        sessionKey: spec.child,
        data: {
          phase: "end",
          endedAt: completedAt,
          terminalReply: { disposition: "visible", text: RESULT_TEXT },
        },
      });
    }
    // Shortly before the 7-day expiry the "outage" requester's channel comes back.
    h.outageEndsAt = completedAt + 7 * DAY + 30 * MIN;
    await waitReal(
      () =>
        Object.values(SPECS).every(
          (spec) =>
            runOf(spec.runId)?.execution.status === "terminal" &&
            // The abandoned requester is never asked to run a turn; its first attempt is only a failed delivery.
            ((runOf(spec.runId)?.delivery?.attemptCount ?? 0) >= 1 ||
              agentCalls.some((call) => call.sessionKey === spec.requester)),
        ),
      "all children completed and a first delivery attempt made",
    );
    await settle(8, 10_000);
    phase("firstAttempt");

    const runs = Object.fromEntries(
      Object.keys(SPECS).map((name) => [name, {}]),
    ) as unknown as Observation["runs"];
    const checkpoint = (label: string) => {
      for (const [name, spec] of Object.entries(SPECS)) {
        runs[name as SpecName][label] = snap(spec.runId);
      }
    };
    checkpoint("afterCompletion");
    // 0-90 min in one-minute steps: announce retries, the 30-minute window, give-up, settle-wake attempts.
    const trail: string[] = [];
    for (let minute = 1; minute <= 90; minute += 1) {
      await advance(MIN, MIN);
      trail.push(
        `${minute}m ${Object.entries(SPECS)
          .map(
            ([name, spec]) =>
              `${name}=${snap(spec.runId).deliveryStatus}/${snap(spec.runId).announceAttempts ?? "-"}${runOf(spec.runId)?.requesterSettleWake ? "/wake" : ""}`,
          )
          .join(" ")} agentCalls=${agentCalls.length}`,
      );
    }
    record("statusTrail90min", trail);
    checkpoint("after90min");
    phase("after90min");
    // Then coarser steps (the sweeper still ticks every minute inside each step).
    await advance(2 * DAY - 90 * MIN, 3 * HOUR);
    checkpoint("afterDay2");
    // A gateway restart on day 2: tear the registry down and restore it from its persisted rows. The
    // markers on the rows (not process memory) must keep the result / notice from being sent again.
    const sendCounts = () =>
      Object.fromEntries(
        Object.entries(SPECS).map(([name, spec]) => [
          name,
          h.outbound.map(sendOf).filter((e) => isSendTo(e, spec)).length +
            h.transcript.filter((w) => w.sessionKey === spec.requester).length,
        ]),
      );
    await settle(8, 10_000);
    const restart = { before: sendCounts(), after: {} as Record<string, number> };
    registry.resetSubagentRegistryForTests({ persist: false });
    registry.initSubagentRegistry();
    registry.activateSubagentRegistry((() => gatewayContext) as never);
    await waitReal(
      () => Object.values(SPECS).every((spec) => runOf(spec.runId) !== undefined),
      "run restoration after the simulated restart",
    );
    await settle(8, 15_000);
    await advance(3 * HOUR, 30 * MIN);
    restart.after = sendCounts();
    checkpoint("afterRestart");
    await advance(4 * DAY + 22 * HOUR - 3 * HOUR, 6 * HOUR);
    checkpoint("beforeRetention"); // day 6 + 22h; retention is 7 days after suspension
    phase("beforeRetention");
    // Retention ends 7 days after suspension (day 7 + ~35 min). Cross it in fine steps and keep going,
    // minute by minute (at most 12 more hours), until every discard has been committed. (B's registry
    // writes go through a real worker, so each discard takes real time; the discards of the several
    // runs follow one another and fake time keeps running meanwhile. Only the order matters here.)
    await advance(4 * HOUR, 30 * MIN);
    const allDiscarded = () =>
      [LOST, ABANDONED, UNDELIVERABLE, NOROUTE, OUTAGE].every(
        (spec) => runOf(spec.runId)?.delivery?.status === "discarded",
      );
    for (let extra = 0; extra < 720 && !allDiscarded(); extra += 1) {
      await advance(MIN, MIN);
    }
    checkpoint("afterRetention"); // day 7 + ~2h
    phase("afterRetention");

    // Queued agent-facing system event(s) (record only) and the durable queue for the media probe.
    const { loadPendingSessionDeliveries } =
      await import("../../src/infra/session-delivery-queue-storage.js");
    const { captureOpenClawStateWorkerContext } =
      await import("../../src/state/openclaw-state-worker-context.js");
    const readQueue = async () =>
      (await pump(
        Promise.resolve(loadPendingSessionDeliveries(captureOpenClawStateWorkerContext() as never)),
      )) as unknown as Array<Record<string, unknown>>;
    let queuedSystemEvents: string[] = [];
    try {
      queuedSystemEvents = (await readQueue())
        .filter((entry) => entry.kind === "systemEvent")
        .map((entry) => String(entry.text ?? ""));
    } catch (error) {
      queuedSystemEvents = [`(unreadable: ${String(error)})`];
    }

    // F2.1b probe: a generated-media task completion (image_generate) is handed to the requester
    // conversation through the durable agent-turn queue, with the media attached.
    const mediaHandoff: Observation["mediaHandoff"] = { queued: [] };
    try {
      const { deliverSubagentAnnouncement } =
        await import("../../src/agents/subagents/announce/subagent-announce-delivery.js");
      const { imageCompletionEvents } =
        await import("../../src/agents/subagent-test-fixtures.test-helpers.js");
      const origin = { channel: "discord", to: REACHABLE.to, accountId: "default" };
      const attachment = {
        type: "image" as const,
        path: IMAGE_PATH,
        name: "ixg-f2-cat.png",
        mimeType: "image/png",
        sizeBytes: 1234,
      };
      mediaHandoff.result = (await pump(
        deliverSubagentAnnouncement({
          requesterSessionKey: REACHABLE.requester,
          targetRequesterSessionKey: REACHABLE.requester,
          triggerMessage: "child done",
          steerMessage: "child done",
          requesterSessionOrigin: origin,
          completionDirectOrigin: origin,
          directOrigin: origin,
          requesterIsSubagent: false,
          expectsCompletionMessage: true,
          bestEffortDeliver: true,
          directIdempotencyKey: "f2-media-handoff",
          internalEvents: imageCompletionEvents({ attachments: [attachment] }),
          sourceTool: "image_generate",
        }),
      )) as unknown as Record<string, unknown>;
      mediaHandoff.queued = (await readQueue()).filter((entry) => entry.kind === "agentTurn");
    } catch (error) {
      mediaHandoff.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
    phase("mediaProbe");
    record("settleStats", stats);
    record(
      "warnErrorLogs",
      h.logs
        .filter((l) => l.level !== "info")
        .map(
          (l) =>
            `${Math.round((l.at - completedAt) / 1000)}s ${l.level} ${l.subsystem}: ${l.message.slice(0, 120)} ${textOf(l.meta ?? "").slice(0, 300)}`,
        ),
    );

    return {
      completedAt,
      agentCalls,
      otherGatewayCalls,
      outbound: [...h.outbound],
      rejected: [...h.rejected],
      transcript: [...h.transcript],
      restart,
      outageEndsAt: h.outageEndsAt,
      hooks: [...h.hookCalls],
      logs: [...h.logs],
      queuedSystemEvents,
      runs,
      mediaHandoff,
    };
  } finally {
    try {
      await vi.advanceTimersByTimeAsync(0);
    } catch {
      // teardown only
    }
    h.lifecycleHandler = undefined;
    announceDeliveryTesting.setDepsForTest();
    announceOutputTesting.setDepsForTest();
    announceTesting.setDepsForTest();
    registry.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (previousFastEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = previousFastEnv;
    }
    await testState.cleanup();
  }
}

// ---- the scenario is computed once and shared by the cases below -------------------------------
let observation: Observation | undefined;
let harnessFailure: string | undefined;

function need(): Observation {
  if (!observation) {
    throw new Error(`harness could not run the F2 flow: ${harnessFailure}`);
  }
  return observation;
}

describe("F2 subagent result delivery", () => {
  beforeAll(async () => {
    try {
      observation = await runScenario();
    } catch (error) {
      harnessFailure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
  }, 150_000);

  it("F2.0 (harness) the detectors: result send, Japanese notice shape, and agent-facing events that do not count", () => {
    const base: Observation = {
      completedAt: 0,
      agentCalls: [],
      otherGatewayCalls: [],
      outbound: [],
      rejected: [],
      transcript: [],
      restart: { before: {}, after: {} },
      outageEndsAt: 0,
      hooks: [{ at: 5, event: { sendFarewell: true, reason: "subagent-complete" } }],
      logs: [
        { at: 5, subsystem: "x", level: "warn", message: "subagent suspended delivery discarded" },
      ],
      queuedSystemEvents: [
        "Task needs follow-up: cat picture. Required completion delivery failed before reaching the requester.",
      ],
      runs: Object.fromEntries(Object.keys(SPECS).map((name) => [name, {}])) as never,
      mediaHandoff: { queued: [] },
    };
    // Hook, log and queued system event do not count, however failure-like their wording is.
    expect(userVisibleFailureNotices(base)).toHaveLength(0);
    // A direct message to the user's conversation does, and the window is honoured.
    const withNotice: Observation = {
      ...base,
      outbound: [
        {
          at: 10,
          via: "sendRecoveryNotice",
          payload: {
            channel: "discord",
            to: "user-2",
            text: "I couldn't deliver the image you asked for. Please ask again.",
          },
        },
      ],
    };
    expect(userVisibleFailureNotices(withNotice)).toHaveLength(1);
    expect(userVisibleFailureNotices(withNotice, { toMs: 9 })).toHaveLength(0);
    // It is credited to the user it names, not to another run's user.
    expect(userVisibleFailureNotices(withNotice, { spec: LOST })).toHaveLength(1);
    expect(userVisibleFailureNotices(withNotice, { spec: ABANDONED })).toHaveLength(0);
    // Wording that is not a failure statement does not count.
    expect(
      userVisibleFailureNotices({
        ...base,
        outbound: [{ at: 10, via: "sendMessage", payload: { text: "Here is your image." } }],
      }),
    ).toHaveLength(0);
    // The result detector needs the text AND the attachment, and reads the effective payload only.
    const resultPayload = {
      to: "user-2",
      content: RESULT_TEXT,
      effective: { text: "Generated 1 image.", mediaUrls: [IMAGE_PATH] },
    };
    const sendsOf2 = (payload: unknown) => ({
      ...base,
      outbound: [{ at: 1, via: "sendMessage", payload }],
    });
    expect(resultSends(sendsOf2(resultPayload), LOST)).toHaveLength(1);
    expect(resultSends(sendsOf2(resultPayload), ABANDONED)).toHaveLength(0);
    expect(
      resultSends(
        sendsOf2({ ...resultPayload, effective: { text: "Generated 1 image.", mediaUrls: [] } }),
        LOST,
      ),
    ).toHaveLength(0);
    // The notice must have the owner's shape: which request, finished, where it failed, why, next step.
    const notice =
      "「cat picture」の作業は終わりましたが、結果をこの会話へお届けできませんでした（結果の送信に失敗しました）。お手数ですが、同じ依頼をもう一度お送りください。";
    expect(NOTICE_SENTENCE.exec(notice)?.slice(1)).toEqual([
      "cat picture",
      "結果の送信に失敗しました",
      "お手数ですが、同じ依頼をもう一度お送りください。",
    ]);
    expect(NOTICE_SENTENCE.test("もう一度お送りください。")).toBe(false);
    expect(NOTICE_SENTENCE.test("I couldn't deliver the image. Please ask again.")).toBe(false);
  });

  it("F2.1 an image-producing subagent that completes reaches the requester conversation with its media", () => {
    const obs = need();
    const turns = obs.agentCalls.filter((call) => call.sessionKey === REACHABLE.requester);
    expect(turns.length, "a requester turn was dispatched for the result").toBeGreaterThanOrEqual(
      1,
    );
    record("reachableRequesterTurnParams", turns[0]?.params);
    // The turn is addressed to the user's conversation and carries the child's result with the media path.
    expect(turns[0]?.params).toMatchObject({ channel: "discord", to: REACHABLE.to });
    expect(textOf(turns[0]?.params)).toContain(IMAGE_PATH);
    // The registry recorded the result as delivered and left nothing waiting.
    expect(obs.runs.reachable.after90min?.deliveryStatus).toBe("delivered");
    expect(obs.runs.reachable.after90min?.hasRequesterSettleWake).toBe(false);
    // And it never fell into the failure path.
    expect(obs.runs.reachable.afterRetention?.deliveryStatus).toBe("delivered");
  });

  it("F2.1b a generated-media task completion is handed to the requester conversation durably, media attached", () => {
    const { mediaHandoff } = need();
    expect(mediaHandoff.error, "probe error").toBeUndefined();
    expect(mediaHandoff.result).toMatchObject({ path: "queued", disposition: "session_queued" });
    const entry = mediaHandoff.queued.find((e) => e.sessionKey === REACHABLE.requester);
    expect(entry, "agent-turn entry for the requester session").toBeDefined();
    expect(textOf(entry?.expectedMediaUrls)).toContain(IMAGE_PATH);
  });

  /** The settle-wake attempts (requester-settle idempotency keys) made for one run's requester. */
  const settleWakeCalls = (obs: Observation, spec: Spec) =>
    obs.agentCalls.filter(
      (call) =>
        call.sessionKey === spec.requester && /requester-settle/.test(call.idempotencyKey ?? ""),
    );
  /** When the settle-wake attempts ran out (the last attempt). */
  const exhaustedAt = (obs: Observation, spec: Spec) =>
    Math.max(...settleWakeCalls(obs, spec).map((call) => call.at));
  /** The sweeper ticks every minute; "as soon as exhausted" means within a couple of ticks. */
  const EARLY_MS = 3 * MIN;

  /** Order item (1), shared by F2.2 and F2.2b. */
  function expectResultDeliveredDirectly(obs: Observation, spec: Spec, name: SpecName) {
    expect(obs.runs[name].after90min?.deliveryStatus, "the wake path gave up and suspended").toBe(
      "suspended",
    );
    const sends = resultSends(obs, spec);
    expect(sends, "exactly one direct delivery of the child's result").toHaveLength(1);
    const [send] = sends as [Send];
    // To the requester conversation's destination (the run's requesterOrigin) ...
    expect(send.payload).toMatchObject({ channel: "discord", to: spec.to, accountId: "default" });
    // ... with the text AND the generated image as an attachment (the MEDIA: directive is not shown).
    expect(send.text).toContain("Generated 1 image.");
    expect(send.text).not.toContain("MEDIA:");
    expect(send.mediaUrls).toEqual([IMAGE_PATH]);
    // The delivery is recorded in the requester session's transcript (the mirror request carries
    // the same text and media).
    expect(send.payload).toMatchObject({ mirror: { sessionKey: spec.requester } });
    expect(
      obs.transcript.filter(
        (w) =>
          w.via === "sendMessage.mirror" &&
          w.sessionKey === spec.requester &&
          w.mediaUrls.includes(IMAGE_PATH) &&
          w.text.includes("Generated 1 image."),
      ),
      "transcript record of the delivery",
    ).toHaveLength(1);
    // Early: right after the settle-wake attempts ran out (not at day 7), within the first 90 minutes.
    const exhausted = exhaustedAt(obs, spec);
    expect(send.at).toBeGreaterThanOrEqual(exhausted);
    expect(send.at - exhausted, "minutes after the last wake attempt").toBeLessThanOrEqual(
      EARLY_MS,
    );
    expect(send.at).toBeLessThanOrEqual(toMs(obs, 90));
    record(`directResultDeliveryAfterLastWakeAttemptMs:${name}`, send.at - exhausted);
    // The result reached the user, so the user is not also told that it failed.
    const notices = noticeSends(obs, spec);
    expect(notices.toUser).toHaveLength(0);
    expect(notices.toRecord).toHaveLength(0);
  }

  it("F2.2 requester cannot be woken after the retries: the result (text AND media) goes straight to its conversation, recorded in its transcript, early", () => {
    expectResultDeliveredDirectly(need(), LOST, "lost");
  });

  it("F2.2b requester session abandoned (requester_abandoned): the result goes straight to its conversation too", () => {
    const obs = need();
    // Precondition: the completion path itself never dispatched a turn to the abandoned requester (only
    // the later settle wake tried), so the direct delivery is the only thing that can reach the user.
    expect(
      obs.agentCalls.filter(
        (call) =>
          call.sessionKey === ABANDONED.requester &&
          !/requester-settle/.test(call.idempotencyKey ?? ""),
      ),
    ).toHaveLength(0);
    expectResultDeliveredDirectly(obs, ABANDONED, "abandoned");
  });

  it("F2.3 notice: when the direct delivery is impossible or fails, the user is told in plain Japanese which request, where it failed, why and what to do", () => {
    const obs = need();
    // The result (it carries an attachment the channel refuses) never reached the user ...
    expect(resultSends(obs, UNDELIVERABLE)).toHaveLength(0);
    expect(
      obs.rejected.map(sendOf).filter((e) => isSendTo(e, UNDELIVERABLE) && isResultSend(e)).length,
      "the direct delivery of the result was attempted and refused",
    ).toBeGreaterThanOrEqual(1);
    // ... so exactly one plain-text notice was sent to the same conversation, early.
    const { toUser, toRecord } = noticeSends(obs, UNDELIVERABLE);
    expect(toUser, "exactly one notice").toHaveLength(1);
    expect(toRecord).toHaveLength(0);
    const [notice] = toUser as [Send];
    expect(notice.payload).toMatchObject({ channel: "discord", to: UNDELIVERABLE.to });
    expect(notice.mediaUrls).toEqual([]);
    expect(notice.payload).toMatchObject({ mirror: { sessionKey: UNDELIVERABLE.requester } });
    expect(notice.at - exhaustedAt(obs, UNDELIVERABLE)).toBeLessThanOrEqual(EARLY_MS);
    record("noticeText:undeliverable", notice.text);
    const parts = NOTICE_SENTENCE.exec(notice.text);
    expect(
      parts,
      "shape: 「{request}」の作業は終わりましたが、結果をこの会話へお届けできませんでした（{reason}）。{next}",
    ).not.toBeNull();
    const [, request, reason, next] = parts as unknown as [string, string, string, string];
    // Which request it was: the run's label ("cat picture"), not an id.
    expect(request).toBe("cat picture");
    // Where it failed and why, in plain words: the delivery of the result with its attachment.
    expect(reason).toContain("送信に失敗");
    expect(reason).toContain("添付");
    // What the person can do next - more than "please send again".
    expect(next).toMatch(/管理者/);
    expect(next.replace(/[。\s]/g, "")).not.toBe("もう一度お送りください");
    // Never raw ids, paths or other plumbing.
    for (const internal of [
      UNDELIVERABLE.runId,
      UNDELIVERABLE.child,
      UNDELIVERABLE.requester,
      "agent:",
      "subagent",
      IMAGE_PATH,
      "/tmp",
      "MEDIA:",
      "idempotency",
    ]) {
      expect(notice.text, `no internal detail "${internal}"`).not.toContain(internal);
    }
    expect(notice.text).toMatch(/[ぁ-んァ-ン一-龠]/);
  });

  it("F2.3 notice: with no destination at all the notice goes to the requester session's record, once", () => {
    const obs = need();
    expect(directSends(obs, NOROUTE)).toHaveLength(0);
    const { toUser, toRecord } = noticeSends(obs, NOROUTE);
    expect(toUser).toHaveLength(0);
    expect(toRecord, "exactly one transcript notice").toHaveLength(1);
    const [write] = toRecord as [(typeof toRecord)[number]];
    const parts = NOTICE_SENTENCE.exec(write.text);
    expect(parts).not.toBeNull();
    expect(parts?.[1]).toBe("cat picture");
    expect(parts?.[2]).toContain("お届け先の会話を特定できませんでした");
    expect(write.at - exhaustedAt(obs, NOROUTE)).toBeLessThanOrEqual(EARLY_MS);
    record("noticeText:noroute", write.text);
  });

  it("F2.3 7-day expiry: the discard is never silent - by then the result was delivered or the user was told", () => {
    const obs = need();
    const cases: Array<[SpecName, Spec]> = [
      ["lost", LOST],
      ["abandoned", ABANDONED],
      ["undeliverable", UNDELIVERABLE],
      ["noroute", NOROUTE],
      ["outage", OUTAGE],
    ];
    for (const [name, spec] of cases) {
      expect(obs.runs[name].afterRetention?.deliveryStatus, `${name} was discarded`).toBe(
        "discarded",
      );
      expect(obs.runs[name].afterRetention?.discardReason).toBe("expired");
      const { toUser, toRecord } = noticeSends(obs, spec);
      const served = [
        ...resultSends(obs, spec).map((e) => e.at),
        ...toUser.map((e) => e.at),
        ...toRecord.map((e) => e.at),
      ];
      expect(
        served.length,
        `${name}: result delivered or user told before the discard`,
      ).toBeGreaterThan(0);
      const discarded = discardAt(obs, spec);
      expect(discarded, `${name}: discard log`).toBeDefined();
      expect(Math.min(...served)).toBeLessThanOrEqual(discarded as number);
    }
    // The expiry itself no longer hides behind a single warn line: the registry says how it was served.
    const lostLog = obs.logs.find(
      (l) =>
        l.message === "subagent suspended delivery discarded" &&
        (l.meta as { runId?: string })?.runId === LOST.runId,
    );
    expect(lostLog?.meta).toMatchObject({ reason: "expired", fallback: "result_sent" });
    const undeliverableLog = obs.logs.find(
      (l) =>
        l.message === "subagent suspended delivery discarded" &&
        (l.meta as { runId?: string })?.runId === UNDELIVERABLE.runId,
    );
    expect(undeliverableLog?.meta).toMatchObject({ reason: "expired", fallback: "notice_sent" });
  });

  it("F2.3 (record) at the expiry the row is discarded with a log line plus a farewell hook; the user was served earlier", () => {
    const obs = need();
    const discardLogs = obs.logs.filter(
      (l) => l.message === "subagent suspended delivery discarded",
    );
    expect(discardLogs.map((l) => (l.meta as { runId?: string })?.runId)).toContain(LOST.runId);
    expect(discardLogs.every((l) => l.level === "warn")).toBe(true);
    expect(discardLogs[0]?.meta).toMatchObject({ reason: "expired" });
    // The hook is the only other thing emitted at discard time; it is not a message to the user.
    const farewell = obs.hooks.filter(
      (c) => c.event.sendFarewell === true && c.event.runId === LOST.runId,
    );
    expect(farewell).toHaveLength(1);
    record(
      "discardLog",
      discardLogs.map((l) => ({ level: l.level, message: l.message, meta: l.meta })),
    );
    record(
      "farewellHookEvents",
      obs.hooks.map((c) => ({ atMs: c.at - obs.completedAt, ...c.event })),
    );
    // What the requester side got at suspension: an agent-facing system event (not counted as a notice).
    record("queuedAgentFacingSystemEvents", obs.queuedSystemEvents);
    record(
      "directUserFacingSendsInWholeRun",
      obs.outbound.map((e) => ({
        via: e.via,
        to: sendOf(e).to,
        atMin: Math.round((e.at - obs.completedAt) / MIN),
      })),
    );
    record(
      "rejectedSendsInWholeRun",
      obs.rejected.map((e) => ({
        via: e.via,
        to: sendOf(e).to,
        atMin: Math.round((e.at - obs.completedAt) / MIN),
      })),
    );
    record(
      "transcriptWritesInWholeRun",
      obs.transcript.map((w) => ({
        via: w.via,
        sessionKey: w.sessionKey,
        atMin: Math.round((w.at - obs.completedAt) / MIN),
        text: w.text.slice(0, 80),
      })),
    );
    record(
      "otherGatewayMethods",
      obs.otherGatewayCalls.map((c) => c.method),
    );
    // Nothing is routed through a gateway "send" method: the direct deliveries use the outbound send.
    expect(
      obs.otherGatewayCalls.filter((c) => /send|notice|notify|message/i.test(c.method)),
    ).toHaveLength(0);
  });

  it("F2.4 (record) the windows are unchanged: announce hard expiry, settle-wake attempts, suspension, retention", () => {
    const obs = need();
    expect(ANNOUNCE_COMPLETION_HARD_EXPIRY_MS).toBe(30 * MIN);
    expect(resolveSuspendedDeliveryExpiryMs()).toBe(7 * DAY);
    const minutesOf = (calls: AgentCall[]) =>
      calls.map((call) => Math.round(((call.at - obs.completedAt) / MIN) * 10) / 10);
    const lostCalls = obs.agentCalls.filter((call) => call.sessionKey === LOST.requester);
    const isSettleWake = (call: AgentCall) => /requester-settle/.test(call.idempotencyKey ?? "");
    const wakeMinutes = minutesOf(lostCalls.filter(isSettleWake));
    const sendMinutes = (spec: Spec) =>
      resultSends(obs, spec).map((e) => Math.round(((e.at - obs.completedAt) / MIN) * 10) / 10);
    record("timeline", {
      announceHardExpiryMin: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS / MIN,
      retentionDays: resolveSuspendedDeliveryExpiryMs() / DAY,
      announceAttemptAtMinutes: minutesOf(lostCalls.filter((call) => !isSettleWake(call))),
      requesterSettleWakeAttemptAtMinutes: wakeMinutes,
      directResultDeliveryAtMinutes: {
        lost: sendMinutes(LOST),
        abandoned: sendMinutes(ABANDONED),
        outage: sendMinutes(OUTAGE),
      },
      runs: obs.runs,
    });
    // Exactly three requester-settle wake attempts, all within the first hour after the child finished
    // (the retry windows are not touched: slow is not failed).
    expect(wakeMinutes).toHaveLength(3);
    expect(Math.max(...wakeMinutes)).toBeLessThan(60);
    // The row is suspended at the end of the 30-minute announce window, as before.
    expect(obs.runs.lost.after90min?.suspendedAtMin).toBeGreaterThanOrEqual(30);
    expect(obs.runs.lost.after90min?.suspendedAtMin).toBeLessThan(40);
  });

  it("F2.5 once the settle-wake attempts are exhausted the result reaches the user at once and exactly once - sweeper ticks, retries and a restart add nothing", () => {
    const obs = need();
    // State left after exhaustion: still suspended (the row waits out its retention), no wake owner.
    expect(obs.runs.lost.afterDay2?.deliveryStatus).toBe("suspended");
    expect(obs.runs.lost.afterDay2?.hasRequesterSettleWake).toBe(false);
    expect(obs.runs.lost.beforeRetention?.deliveryStatus).toBe("suspended");
    // No re-wake after exhaustion (the wake windows are unchanged) ...
    const lastWake = exhaustedAt(obs, LOST);
    expect(
      obs.agentCalls.filter((c) => c.sessionKey === LOST.requester && c.at > lastWake),
    ).toHaveLength(0);
    // ... and still the user was served: once, for the whole 7 days, whatever ticked in between.
    expect(resultSends(obs, LOST)).toHaveLength(1);
    expect(resultSends(obs, ABANDONED)).toHaveLength(1);
    expect(noticeSends(obs, UNDELIVERABLE).toUser).toHaveLength(1);
    expect(noticeSends(obs, NOROUTE).toRecord).toHaveLength(1);
    // The reachable requester is not touched by the fallback at all.
    expect(directSends(obs, REACHABLE)).toHaveLength(0);
    // The restart on day 2 did not make any run send again - the markers live on the persisted row.
    for (const name of ["lost", "abandoned", "undeliverable", "noroute"] as const) {
      expect(obs.restart.after[name], `${name}: sends after the restart`).toBe(
        obs.restart.before[name],
      );
      expect(obs.restart.before[name], `${name}: served before the restart`).toBeGreaterThanOrEqual(
        1,
      );
    }
    expect(obs.runs.lost.afterRestart?.fallback).toMatchObject({ resultSent: true });
    expect(obs.runs.abandoned.afterRestart?.fallback).toMatchObject({ resultSent: true });
    expect(obs.runs.undeliverable.afterRestart?.fallback).toMatchObject({ noticeSent: true });
    expect(obs.runs.noroute.afterRestart?.fallback).toMatchObject({ noticeSent: true });
    expect(obs.runs.lost.afterRestart?.deliveryStatus).toBe("suspended");
    // Nothing was sent twice with the same idempotency key.
    const keys = obs.outbound
      .map((e) => (e.payload as { idempotencyKey?: string })?.idempotencyKey)
      .filter(
        (key): key is string =>
          typeof key === "string" && key.startsWith("subagent-suspended-final:"),
      );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("F2.6 the channel is down for days: the sweeper retries, and the discard-time backstop still delivers before the row is discarded", () => {
    const obs = need();
    const sends = resultSends(obs, OUTAGE);
    expect(sends, "exactly one direct delivery of the result").toHaveLength(1);
    const [send] = sends as [Send];
    const rejected = obs.rejected.map(sendOf).filter((e) => isSendTo(e, OUTAGE));
    // While the channel was down every attempt (result, then notice) was refused and retried with a backoff.
    expect(rejected.length, "refused sends while the channel was down").toBeGreaterThanOrEqual(6);
    expect(rejected.every((e) => e.at < obs.outageEndsAt)).toBe(true);
    // Nothing reached the user before the channel came back, and no notice was needed afterwards.
    expect(send.at).toBeGreaterThanOrEqual(obs.outageEndsAt);
    expect(noticeSends(obs, OUTAGE).toUser).toHaveLength(0);
    // It is delivered before (or at) the discard, never after the row is gone: the channel came back
    // only minutes before the expiry, so it is the discard path's backstop that delivers it.
    const discarded = discardAt(obs, OUTAGE);
    expect(discarded).toBeDefined();
    expect(send.at).toBeLessThanOrEqual(discarded as number);
    expect(
      (discarded as number) - send.at,
      "delivered by the backstop right before the discard",
    ).toBeLessThanOrEqual(MIN);
    expect(send.payload).toMatchObject({ mirror: { sessionKey: OUTAGE.requester } });
    record("outageRecord", {
      refusedSends: rejected.length,
      deliveredMinutesAfterOutageEnd: Math.round(((send.at - obs.outageEndsAt) / MIN) * 10) / 10,
      discardedMinutesAfterDelivery:
        Math.round((((discarded as number) - send.at) / MIN) * 10) / 10,
    });
    expect(
      obs.logs.some(
        (l) =>
          l.message === "subagent suspended delivery reached its expiry without reaching the user",
      ),
    ).toBe(false);
  });
});
