// F2: a child task (here an image-producing subagent) finishes, but its result never reaches the
// requester's conversation. In production the child finished, the requester session could not be
// woken, the result stayed "suspended delivery pending", and a week later the registry logged
// `subagent suspended delivery discarded reason=expired`. The user got nothing.
//
// DESIRED behavior asserted here:
//   (1) the child's result (including the generated image) reaches the requester's conversation;
//   (2) when it cannot be delivered, the user is told in plain words that it failed - never a silent expiry.
//
// What counts as a "user-visible plain-language notice" (decided once, used by F2.2 / F2.3 / F2.5):
//   a message sent DIRECTLY toward the user's conversation, without needing the requester agent to wake
//   and compose it: infra/outbound `sendMessage`, `deliverOutboundPayloads`, a gateway `send`-style call,
//   or `GatewayRecoveryRuntime.sendRecoveryNotice` (the existing precedent: main-session restart recovery
//   and pending-delivery notices use it to tell the user "I couldn't ..."). Its text must say in plain
//   words that the result could not be delivered / failed.
//   NOT counted: (a) the `kind: "systemEvent"` that blockSubagentCompletionDelivery queues for the
//   requester session - it is addressed to the requester AGENT and only reaches the user if that same
//   requester can be woken and chooses to relay it, which is exactly what failed (it is recorded in the
//   F2.3 (record) case); (b) the `subagent_ended` hook with sendFarewell - it only unbinds thread
//   bindings (Discord/Matrix/Feishu) and feeds workboard; (c) logs.
//
// The cases run the REAL registry / announce / requester-settle-wake / sweeper code under fake timers
// (the product flow, in the style of subagent-registry.requester-wake.e2e.test.ts). Only the network
// edge is faked: callGateway (requester agent turns), outbound send, and the session store. No real keys,
// no network, no customer data; the channel is a stand-in id and LINE WORKS' plugin is not used.
// Three requesters run side by side in one registry (which keeps B's slow worker start-up to a single
// cold start): one reachable (F2.1), one whose agent turn can never be started (F2.2, F2.3, F2.5) and
// one whose session is "abandoned" so the announce path refuses to wake it (F2.2b).
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
// Every direct-to-user send path is recorded here and made harmless.
vi.mock("../../src/infra/outbound/message.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infra/outbound/message.js")>()),
  sendMessage: vi.fn(async (payload: unknown) => {
    h.outbound.push({ at: Date.now(), via: "sendMessage", payload });
    return {
      channel: "discord",
      to: "user-1",
      via: "direct",
      mediaUrl: null,
      result: { messageId: "m-1" },
    };
  }),
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
const SPECS = { reachable: REACHABLE, lost: LOST, abandoned: ABANDONED } as const;
type SpecName = keyof typeof SPECS;
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
  const direct = obs.outbound.map((e) => ({ at: e.at, via: e.via, text: textOf(e.payload) }));
  const gatewaySends = obs.otherGatewayCalls
    .filter((c) => /send|notice|notify|message/i.test(c.method))
    .map((c) => ({ at: c.at, via: `gateway:${c.method}`, text: textOf(c.params) }));
  return [...direct, ...gatewaySends].filter(
    (e) =>
      inWindow(e.at) &&
      FAILURE_WORDING.test(e.text) &&
      (opts?.spec === undefined || mentionsSpec(e.text, opts.spec)),
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
  h.logs.length = 0;
  h.hookCalls.length = 0;
  h.outbound.length = 0;
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
        // Neither of these requesters can be woken, whichever way the product tries (an abandoned
        // session is refused by the announce path itself, but the settle wake still dispatches a turn).
        if (sessionKey === LOST.requester || sessionKey === ABANDONED.requester) {
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
    delivery: {
      kind: "external",
      route: { channel: "discord", accountId: "default", target: { to } },
      context: { channel: "discord", to, accountId: "default" },
      origin: { provider: "discord", to, accountId: "default" },
    },
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
          requesterOrigin: { channel: "discord", to: spec.to, accountId: "default" },
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
    await waitReal(
      () =>
        Object.values(SPECS).every(
          (spec) =>
            runOf(spec.runId)?.execution.status === "terminal" &&
            // The abandoned requester is never asked to run a turn; its first attempt is only a failed delivery.
            (spec === ABANDONED
              ? (runOf(spec.runId)?.delivery?.attemptCount ?? 0) >= 1
              : agentCalls.some((call) => call.sessionKey === spec.requester)),
        ),
      "all children completed and a first delivery attempt made",
    );
    await settle(8, 10_000);
    phase("firstAttempt");

    const runs: Observation["runs"] = { reachable: {}, lost: {}, abandoned: {} };
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
    await advance(4 * DAY + 22 * HOUR, 6 * HOUR);
    checkpoint("beforeRetention"); // day 6 + 22h; retention is 7 days after suspension
    phase("beforeRetention");
    // Retention ends 7 days after suspension (day 7 + ~35 min). Cross it in fine steps and keep going,
    // minute by minute (at most 3 more hours), until every discard has been committed.
    await advance(4 * HOUR, 30 * MIN);
    const allDiscarded = () =>
      [LOST, ABANDONED].every((spec) => runOf(spec.runId)?.delivery?.status === "discarded");
    for (let extra = 0; extra < 180 && !allDiscarded(); extra += 1) {
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

  it("F2.0 (harness) the notice detector accepts a direct plain failure message and ignores agent-facing events", () => {
    const base: Observation = {
      completedAt: 0,
      agentCalls: [],
      otherGatewayCalls: [],
      outbound: [],
      hooks: [{ at: 5, event: { sendFarewell: true, reason: "subagent-complete" } }],
      logs: [
        { at: 5, subsystem: "x", level: "warn", message: "subagent suspended delivery discarded" },
      ],
      queuedSystemEvents: [
        "Task needs follow-up: cat picture. Required completion delivery failed before reaching the requester.",
      ],
      runs: { reachable: {}, lost: {}, abandoned: {} },
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

  it("F2.2 requester cannot be woken after the retries: the user is told in plain words that the result failed", () => {
    const obs = need();
    // By 90 minutes (30-minute retry window + the settle-wake attempts) the product has given up.
    expect(obs.runs.lost.after90min?.deliveryStatus, "gave up and suspended").toBe("suspended");
    const notices = userVisibleFailureNotices(obs, {
      toMs: obs.completedAt + 90 * MIN,
      spec: LOST,
    });
    expect(
      notices,
      "a direct user-visible failure notice (sendMessage / recovery notice / gateway send)",
    ).not.toHaveLength(0);
  });

  it("F2.2b requester session abandoned (requester_abandoned): the user is told in plain words that the result failed", () => {
    const obs = need();
    expect(obs.runs.abandoned.after90min?.deliveryStatus, "gave up and suspended").toBe(
      "suspended",
    );
    // Precondition: the completion path itself never dispatched a turn to the abandoned requester (only
    // the later settle wake tried), so a direct message is the only thing that can still reach the user.
    expect(
      obs.agentCalls.filter(
        (call) =>
          call.sessionKey === ABANDONED.requester &&
          !/requester-settle/.test(call.idempotencyKey ?? ""),
      ),
    ).toHaveLength(0);
    const notices = userVisibleFailureNotices(obs, {
      toMs: obs.completedAt + 90 * MIN,
      spec: ABANDONED,
    });
    expect(notices, "a direct user-visible failure notice naming that user").not.toHaveLength(0);
  });

  it("F2.3 7-day expiry: the discard is not silent - the user is told the result could not be delivered", () => {
    const obs = need();
    expect(obs.runs.lost.afterRetention?.deliveryStatus).toBe("discarded");
    expect(obs.runs.lost.afterRetention?.discardReason).toBe("expired");
    const notices = userVisibleFailureNotices(obs, { spec: LOST });
    expect(
      notices,
      "by the time the result is discarded the user must have been told, at the latest at the discard",
    ).not.toHaveLength(0);
  });

  it("F2.3 (record) today the expiry is a log line plus a farewell hook only", () => {
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
      obs.outbound.map((e) => e.via),
    );
    record(
      "otherGatewayMethods",
      obs.otherGatewayCalls.map((c) => c.method),
    );
    expect(obs.outbound).toHaveLength(0);
    expect(
      obs.otherGatewayCalls.filter((c) => /send|notice|notify|message/i.test(c.method)),
    ).toHaveLength(0);
  });

  it("F2.4 (record) the windows: announce hard expiry, settle-wake attempts, suspension, retention", () => {
    const obs = need();
    expect(ANNOUNCE_COMPLETION_HARD_EXPIRY_MS).toBe(30 * MIN);
    expect(resolveSuspendedDeliveryExpiryMs()).toBe(7 * DAY);
    const minutesOf = (calls: AgentCall[]) =>
      calls.map((call) => Math.round(((call.at - obs.completedAt) / MIN) * 10) / 10);
    const lostCalls = obs.agentCalls.filter((call) => call.sessionKey === LOST.requester);
    const isSettleWake = (call: AgentCall) => /requester-settle/.test(call.idempotencyKey ?? "");
    const wakeMinutes = minutesOf(lostCalls.filter(isSettleWake));
    record("timeline", {
      announceHardExpiryMin: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS / MIN,
      retentionDays: resolveSuspendedDeliveryExpiryMs() / DAY,
      announceAttemptAtMinutes: minutesOf(lostCalls.filter((call) => !isSettleWake(call))),
      requesterSettleWakeAttemptAtMinutes: wakeMinutes,
      runs: obs.runs,
    });
    // Exactly three requester-settle wake attempts, all within the first hour after the child finished.
    expect(wakeMinutes).toHaveLength(3);
    expect(Math.max(...wakeMinutes)).toBeLessThan(60);
  });

  it("F2.5 after the settle-wake attempts are exhausted nothing re-wakes the row or tells the user before the 7-day discard", () => {
    const obs = need();
    // State left after exhaustion: still suspended, no wake owner.
    expect(obs.runs.lost.afterDay2?.deliveryStatus).toBe("suspended");
    expect(obs.runs.lost.afterDay2?.hasRequesterSettleWake).toBe(false);
    expect(obs.runs.lost.beforeRetention?.deliveryStatus).toBe("suspended");
    // Desired: between exhaustion and day 7 either the requester is woken again, or the user has been
    // told (a notice at any time after the 30-minute announce window counts, including one sent at
    // suspension or at exhaustion).
    const lastSettleWake = Math.max(
      ...obs.agentCalls
        .filter(
          (call) =>
            call.sessionKey === LOST.requester &&
            /requester-settle/.test(call.idempotencyKey ?? ""),
        )
        .map((call) => call.at),
    );
    const quietTo = obs.completedAt + 6 * DAY + 22 * HOUR;
    const laterWakes = obs.agentCalls.filter(
      (call) =>
        call.sessionKey === LOST.requester && call.at > lastSettleWake && call.at <= quietTo,
    );
    const notices = userVisibleFailureNotices(obs, {
      fromMs: obs.completedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
      toMs: quietTo,
      spec: LOST,
    });
    expect(
      laterWakes.length + notices.length,
      "re-wake attempts or user notices between exhaustion and day 7",
    ).toBeGreaterThan(0);
  });
});
