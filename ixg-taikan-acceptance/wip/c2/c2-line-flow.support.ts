// C2 (Issue #5) harness: the REAL bundled LINE extension of the tree under test, wired the way the gateway wires it.
//
//   real HTTP socket
//     -> real gateway plugin-route dispatcher (src/gateway/server/plugins-http.ts, which wraps every
//        non-operator plugin route in runWithGatewayHttpWorkAdmission = the "request admission")
//     -> real extensions/line monitorLineProvider route (signature check, body cap, ...)
//     -> real createLineBot / durable webhook spool (SQLite file in a temp state dir) / drain pump
//     -> real handleLineWebhookEvents + buildLineMessageContext (real media download + real media store)
//     -> core.channel.inbound.run  <- the ONLY fake: the "agent turn boundary" (see below)
//
// The fake `inbound.run` models the first thing a real turn does: it enqueues work in a command lane
// (enqueueCommandInLane, the same admission gate the real embedded-agent runner hits), then adopts the
// event (turnAdoptionLifecycle.onAdopted). That is exactly where the production incident was thrown:
// `[line] auto-reply failed: GatewayDrainingError: Gateway is draining; new tasks are not accepted`.
//
// No network: global fetch is replaced by a vi.fn() stub (the LINE media/profile/reply endpoints are answered
// from memory and every call is recorded; any other URL throws). All secrets are obvious dummies.
//
// Works on both trees: the files are copied to <tree>/test/ixg-taikan/ and import that tree's src.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createEmptyPluginRegistry,
  createPluginRuntimeMock,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { vi } from "vitest";
import { setLineRuntime } from "../../extensions/line/src/runtime.js";
import { createGatewayPluginRequestHandler } from "../../src/gateway/server/plugins-http.js";
import { enqueueCommandInLane } from "../../src/process/command-queue.js";

export const DUMMY_SECRET = "c2-dummy-channel-secret-not-a-real-secret"; // pragma: allowlist secret
export const DUMMY_TOKEN = "c2-dummy-channel-access-token-not-a-real-token"; // pragma: allowlist secret
export const DUMMY_USER = "U00000000000000000000000000c2user";
export const WEBHOOK_PATH = "/line/webhook";

// ---------------------------------------------------------------------------------------------
// LINE payload builders (shapes follow @line/bot-sdk webhook types)
// ---------------------------------------------------------------------------------------------
let eventCounter = 0;
export function nextId(prefix: string): string {
  eventCounter += 1;
  return `${prefix}${String(eventCounter).padStart(6, "0")}`;
}

type EventBase = {
  messageId?: string;
  userId?: string;
  webhookEventId?: string;
  isRedelivery?: boolean;
};

function baseEvent(params: EventBase) {
  return {
    type: "message" as const,
    mode: "active" as const,
    timestamp: Date.now(),
    webhookEventId: params.webhookEventId ?? nextId("01C2WEBHOOKEVT"),
    deliveryContext: { isRedelivery: params.isRedelivery ?? false },
    source: { type: "user" as const, userId: params.userId ?? DUMMY_USER },
    replyToken: nextId("c2-reply-token-"),
  };
}

export function textEvent(params: EventBase & { text: string }) {
  const id = params.messageId ?? nextId("c2msg");
  return {
    ...baseEvent(params),
    message: { id, type: "text" as const, quoteToken: `c2-quote-${id}`, text: params.text },
  };
}

export function imageEvent(params: EventBase) {
  const id = params.messageId ?? nextId("c2img");
  return {
    ...baseEvent(params),
    message: {
      id,
      type: "image" as const,
      quoteToken: `c2-quote-${id}`,
      contentProvider: { type: "line" as const },
    },
  };
}

export function fileEvent(params: EventBase & { fileName: string; fileSize: number }) {
  const id = params.messageId ?? nextId("c2file");
  return {
    ...baseEvent(params),
    message: { id, type: "file" as const, fileName: params.fileName, fileSize: params.fileSize },
  };
}

export type LineEvent =
  | ReturnType<typeof textEvent>
  | ReturnType<typeof imageEvent>
  | ReturnType<typeof fileEvent>;

export function callbackBody(events: LineEvent[]): string {
  return JSON.stringify({ destination: "Uc2dummydestination0000000000000000", events });
}

export function signLineBody(body: string, secret = DUMMY_SECRET): string {
  return crypto.createHmac("SHA256", secret).update(body).digest("base64");
}

/** A PDF-looking blob of exactly `bytes` bytes (header + zero fill; contents are irrelevant to the transport). */
export function fakePdf(bytes: number): Buffer {
  const head = Buffer.from("%PDF-1.4\n% c2 acceptance dummy document\n", "utf8");
  const out = Buffer.alloc(bytes, 0x20);
  head.copy(out, 0);
  out.write("\n%%EOF\n", bytes - 7, "utf8");
  return out;
}

/** A tiny valid PNG (1x1), enough for the media store's content sniffing. */
export function fakePng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
}

// ---------------------------------------------------------------------------------------------
// Raw HTTP client (not fetch: fetch is stubbed for the LINE API)
// ---------------------------------------------------------------------------------------------
export type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  durationMs: number;
};

export function httpRequest(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method ?? "POST",
        headers: {
          "content-type": "application/json",
          ...(options.body === undefined
            ? {}
            : { "content-length": Buffer.byteLength(options.body) }),
          ...options.headers,
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            durationMs: Date.now() - started,
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
// LINE API fetch stub (media / profile / loading / reply / push). Always a vi.fn(): core's
// fetchWithRuntimeDispatcherOrMockedGlobal only honours the global when it is a mock; otherwise it
// would open a real connection.
// ---------------------------------------------------------------------------------------------
export type FetchCall = { url: string; method: string; body?: string };
export type MediaFixture = { bytes: Buffer; contentType: string };

export function installLineFetchStub(media: Map<string, MediaFixture>) {
  const calls: FetchCall[] = [];
  const stub = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: string }).url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    const contentMatch = /^https:\/\/api-data\.line\.me\/v2\/bot\/message\/([^/]+)\/content$/.exec(
      url,
    );
    if (contentMatch) {
      const fixture = media.get(decodeURIComponent(contentMatch[1] ?? ""));
      if (!fixture) {
        return new Response("not found", { status: 404 });
      }
      return new Response(new Uint8Array(fixture.bytes), {
        status: 200,
        headers: { "content-type": fixture.contentType },
      });
    }
    if (url.startsWith("https://api.line.me/v2/bot/profile/") || url.includes("/v2/bot/group/")) {
      return json(200, { displayName: "C2 Test User", userId: DUMMY_USER });
    }
    if (url.startsWith("https://api.line.me/v2/bot/chat/loading/start")) {
      return json(202, {});
    }
    if (
      url.startsWith("https://api.line.me/v2/bot/message/reply") ||
      url.startsWith("https://api.line.me/v2/bot/message/push")
    ) {
      return json(200, { sentMessages: [{ id: "c2-sent-1" }] });
    }
    throw new Error(
      `C2 harness: unexpected outbound request blocked (no network): ${method} ${url}`,
    );
  });
  vi.stubGlobal("fetch", stub);
  return { calls, stub };
}

/** Calls that would put a message in front of the LINE user (reply or push). */
export function userVisibleSends(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter((call) => /\/v2\/bot\/message\/(reply|push)/.test(call.url));
}

// ---------------------------------------------------------------------------------------------
// The agent-turn boundary
// ---------------------------------------------------------------------------------------------
export type TurnRecord = {
  messageId: string;
  rawBody: string;
  bodyForAgent: string;
  mediaPaths: string[];
  mediaTypes: string[];
  from: string;
  replyToken: string | undefined;
  ctx: Record<string, unknown>;
};

export type TurnHooks = {
  /** Runs inside the delivery, before the lane enqueue (hold the turn here to keep a claim in flight). */
  beforeEnqueue?: (record: TurnRecord, callIndex: number) => Promise<void> | void;
  /** Runs after the turn was adopted (a throw here is a failure after adoption = terminal). */
  afterAdopt?: (record: TurnRecord, callIndex: number) => Promise<void> | void;
};

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function toTurnRecord(raw: {
  ctxPayload: Record<string, unknown>;
  replyToken?: string;
}): TurnRecord {
  const ctx = raw.ctxPayload;
  return {
    messageId: String(ctx.MessageSid ?? ctx.MessageSidFull ?? ""),
    rawBody: String(ctx.RawBody ?? ""),
    bodyForAgent: String(ctx.BodyForAgent ?? ""),
    mediaPaths: toStringArray(ctx.MediaPaths ?? ctx.MediaPath),
    mediaTypes: toStringArray(ctx.MediaTypes ?? ctx.MediaType),
    from: String(ctx.From ?? ""),
    replyToken: raw.replyToken,
    ctx,
  };
}

// ---------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------
export type FlowOptions = {
  /** Reuse a state dir (restart simulation). Created (and later removed by the owner) when omitted. */
  stateDir?: string;
  media?: Map<string, MediaFixture>;
  mediaMaxMb?: number;
  hooks?: TurnHooks;
  /** Wrap the spool's durable queue (fault injection). */
  wrapQueue?: (queue: IngressQueue) => IngressQueue;
  /** Reuse an existing fetch stub (restart simulation keeps one record). */
  fetchStub?: ReturnType<typeof installLineFetchStub>;
};

type IngressQueue = ReturnType<typeof createChannelIngressQueueForTests<SpoolPayload>>;
export type SpoolPayload = { version: number; rawEvent: string; destination: string };

export async function makeStateDir(prefix = "c2-line-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return await fs.realpath(dir);
}

export async function removeStateDir(dir: string): Promise<void> {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(dir, { recursive: true, force: true });
}

export type LineFlow = Awaited<ReturnType<typeof startLineFlow>>;

export async function startLineFlow(options: FlowOptions = {}) {
  const { monitorLineProvider } = await import("../../extensions/line/src/monitor.js");
  const ownsStateDir = options.stateDir === undefined;
  const stateDir = options.stateDir ?? (await makeStateDir());
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

  const media = options.media ?? new Map<string, MediaFixture>();
  const fetchStub = options.fetchStub ?? installLineFetchStub(media);

  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);

  const runtimeErrors: string[] = [];
  const runtimeLogs: string[] = [];
  const attempts: TurnRecord[] = []; // every invocation of the agent boundary
  const reached: TurnRecord[] = []; // turns whose lane enqueue succeeded (= agent work started)
  const refused: Array<{ record: TurnRecord; error: unknown }> = []; // lane enqueue refused
  let callIndex = 0;

  const innerQueue = createChannelIngressQueueForTests<SpoolPayload>({
    channelId: "line",
    accountId: "default",
    stateDir,
  });
  const queueForSpool = options.wrapQueue ? options.wrapQueue(innerQueue) : innerQueue;

  const inboundRun = async (params: {
    raw: {
      ctxPayload: Record<string, unknown>;
      replyToken?: string;
      route: { sessionKey: string };
    };
    turnAdoptionLifecycle?: { onAdopted?: () => Promise<void> | void };
  }) => {
    const record = toTurnRecord(params.raw);
    const index = callIndex++;
    attempts.push(record);
    await options.hooks?.beforeEnqueue?.(record, index);
    try {
      // Same admission gate the embedded-agent runner's session lane goes through.
      await enqueueCommandInLane(`c2-session:${params.raw.route.sessionKey}`, async () => {
        reached.push(record);
      });
    } catch (error) {
      refused.push({ record, error });
      throw error;
    }
    await params.turnAdoptionLifecycle?.onAdopted?.();
    await options.hooks?.afterAdopt?.(record, index);
    return { admission: { kind: "dispatch" as const }, dispatched: false as const };
  };

  const pluginRuntime = createPluginRuntimeMock({
    channel: { inbound: { run: inboundRun, turn: { run: inboundRun } } },
    state: { openChannelIngressQueue: () => queueForSpool },
  } as never);
  setLineRuntime(pluginRuntime as never);

  const config = {
    channels: {
      line: {
        enabled: true,
        channelAccessToken: DUMMY_TOKEN,
        channelSecret: DUMMY_SECRET,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...(options.mediaMaxMb === undefined ? {} : { mediaMaxMb: options.mediaMaxMb }),
      },
    },
  };

  const monitor = await monitorLineProvider({
    channelAccessToken: DUMMY_TOKEN,
    channelSecret: DUMMY_SECRET,
    accountId: "default",
    config: config as never,
    runtime: {
      log: (...args: unknown[]) => runtimeLogs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => runtimeErrors.push(args.map(String).join(" ")),
      exit: () => {
        throw new Error("exit() called by the LINE monitor");
      },
    } as never,
  });

  const pluginHandler = createGatewayPluginRequestHandler({
    registry,
    log: {
      subsystem: "c2",
      isEnabled: () => false,
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      raw() {},
      child() {
        return this;
      },
    } as never,
  });
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const handled = await pluginHandler(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.end("not handled by a plugin route");
        }
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        res.end(`gateway threw: ${String(error)}`);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${WEBHOOK_PATH}`;

  // A second handle on the same SQLite file for assertions (never wrapped).
  const reader = createChannelIngressQueueForTests<SpoolPayload>({
    channelId: "line",
    accountId: "default",
    stateDir,
  });

  const post = (events: LineEvent[], extra?: { body?: string; signature?: string | null }) => {
    const body = extra?.body ?? callbackBody(events);
    const headers: Record<string, string> = {};
    if (extra?.signature !== null) {
      headers["x-line-signature"] = extra?.signature ?? signLineBody(body);
    }
    return httpRequest(url, { body, headers });
  };

  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await monitor.stop();
  };

  return {
    url,
    stateDir,
    ownsStateDir,
    post,
    stop,
    monitor,
    reader,
    fetchStub,
    media,
    attempts,
    reached,
    refused,
    runtimeErrors,
    runtimeLogs,
    registry,
    async cleanup() {
      await stop();
      if (ownsStateDir) {
        await removeStateDir(stateDir);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Queue observation helpers (public queue API only; works on both trees)
// ---------------------------------------------------------------------------------------------
export async function queueSnapshot(reader: LineFlow["reader"]) {
  const pending = await reader.listPending({ limit: "all" });
  const claims = await reader.listClaims();
  const failed = (await reader.listFailed?.({ limit: "all" })) ?? [];
  return { pending, claims, failed };
}

/** Verdict the durable queue has for an event id: probes with a throw-away enqueue of the same id. */
export async function verdictFor(reader: LineFlow["reader"], eventId: string) {
  const probe = await reader.enqueue(eventId, { version: 1, rawEvent: "{}", destination: "" });
  return probe.kind;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  options: { timeoutMs?: number; intervalMs?: number; what: string },
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${options.what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25));
  }
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
