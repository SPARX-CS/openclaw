// F5: tool failures (acceptance tests for the "bot circled around a failing pdf tool for 6.5 minutes" type).
//
// Production case: the pdf tool was given (a) a URL that needs auth (HTTP 401) and (b) a local path outside
// the allowed locations. The bot retried with varied URLs/paths for 6.5 minutes and the user only saw "processing".
//
// Desired behavior asserted here (each `it` states the DESIRED behavior; FAIL = not passing on that version):
//   (1) a tool failure comes back to the model quickly, understandably, without a hang or retry loop;
//   (2) the error / guidance shows how to open it (authenticated fetch, or the setting for allowed locations);
//   (3) when it cannot be opened, the user is told the situation (and the loop is stopped/escalated).
//
// Seams (all version-stable, hermetic): the REAL pdf tool (src/agents/tools/pdf-tool.ts) driven up to the document
// load, against a loopback 401 server (127.0.0.1 only) or real temp dirs; toToolDefinitions (what the model sees);
// buildFailureWarning (what the user sees); wrapToolWithBeforeToolCallHook + resolveToolLoopDetectionConfig
// (loop protection as wired in production); detectToolCallLoop/recordToolCall* (loop detector API).
// The model infra (complete / completeSimple, which differs between 9.6 and 9.7) is never reached.
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_GUIDANCE,
  PATH_REMEDY,
  callPdfExpectFailure,
  createRealPdfTool,
  guidanceTextOf,
  makeTempDir,
  record,
  removeTempDirs,
  resetRecords,
  startAuthWall,
  type AuthWall,
} from "./f5-tool-failure.support.js";

const SHORT_MS = 5_000; // "quickly": a local failure must come back well inside this
const PROXY_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

let wall: AuthWall;
let stateDir: string;
let elsewhereDir: string; // a directory that is NOT under any default allowed root and not the workspace

// The repo's vitest setup restores stubbed env vars after every test, so stub them per test.
beforeEach(() => {
  for (const name of PROXY_VARS) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

beforeAll(async () => {
  resetRecords();
  stateDir = await makeTempDir("f5-state-");
  elsewhereDir = await makeTempDir("f5-elsewhere-");
  wall = await startAuthWall();
  // Warm the heavy module graph once so per-test timings below measure the failure path, not module loading.
  await import("../../src/agents/tools/pdf-tool.js");
  await import("../../src/agents/agent-tools.before-tool-call.js");
  await import("../../src/agents/agent-tool-definition-adapter.js");
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await wall?.close();
  await removeTempDirs();
});

async function writeFakePdf(dir: string, name: string): Promise<string> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, "%PDF-1.4 f5 fake pdf");
  return file;
}

describe("F5 tool failure: pdf tool 401 URL / path outside allowed locations", () => {
  // ---------------------------------------------------------------- (1) quick, understandable failure
  it("F5.1 a URL that needs auth (HTTP 401) fails back quickly: one fetch attempt, rejection names HTTP 401", async () => {
    const tool = await createRealPdfTool();
    const before = wall.hitCount();
    const failed = await callPdfExpectFailure(tool, wall.url("/private/report.pdf"));
    record("F5.1 401 error text", failed.message);
    expect(failed.ms, `401 took ${Math.round(failed.ms)} ms`).toBeLessThan(SHORT_MS);
    expect(wall.hitCount() - before, "fetch attempts that reached the origin").toBe(1);
    expect(failed.message).toMatch(/\b401\b/);
  });

  it("F5.3 a local path outside the allowed locations is rejected quickly and the rejection names the path", async () => {
    const tool = await createRealPdfTool();
    const outside = await writeFakePdf(elsewhereDir, "report.pdf");
    const failed = await callPdfExpectFailure(tool, outside);
    record("F5.3 denied-path error text", failed.message);
    expect(failed.ms, `denial took ${Math.round(failed.ms)} ms`).toBeLessThan(SHORT_MS);
    expect(failed.message).toContain(outside);
  });

  // ---------------------------------------------------------------- (2) guidance on how to open it
  it("F5.2 the 401 error says how to open it (authenticated fetch / how to supply credentials)", async () => {
    const tool = await createRealPdfTool();
    const url = wall.url("/private/guide.pdf");
    const failed = await callPdfExpectFailure(tool, url);
    const guidance = guidanceTextOf(failed.message, [url]);
    // Keep the actual text first: the report records it.
    expect(
      AUTH_GUIDANCE.test(guidance),
      `no auth guidance in the 401 error; actual="${failed.message}"`,
    ).toBe(true);
  });

  it("F5.2b setting present: with tools.web.fetch.headers.Authorization configured, the pdf tool's own fetch carries it (an authenticated fetch is possible)", async () => {
    const tool = await createRealPdfTool({
      webFetch: { headers: { Authorization: "Bearer f5-test-token" } },
    });
    const before = wall.hitCount();
    await callPdfExpectFailure(tool, wall.url("/private/with-header.pdf"));
    const sent = wall.authorizationHeaders().slice(before);
    // (Message avoids the words that the repo's vitest reporter redacts as credentials.)
    const forwarded = sent.length === 1 && sent[0] === "Bearer f5-test-token";
    expect(
      forwarded,
      `configured header was not forwarded by the pdf fetch (origin saw: ${sent.map((v) => (v ? "a header" : "no auth header")).join(",")}); tools.web.fetch.headers only feeds web_fetch`,
    ).toBe(true);
  });

  it("F5.4 the denied-path error names the setting that controls allowed locations (or a concrete remedy)", async () => {
    const tool = await createRealPdfTool();
    const outside = await writeFakePdf(elsewhereDir, "guide.pdf");
    const failed = await callPdfExpectFailure(tool, outside);
    const guidance = guidanceTextOf(failed.message, [outside]);
    expect(
      PATH_REMEDY.test(guidance),
      `no setting/remedy in the denied-path error; actual="${failed.message}"`,
    ).toBe(true);
  });

  it("F5.5 setting present: with tools.fs.workspaceOnly=false a PDF under a default allowed root opens (pdf load path)", async () => {
    const opened = await openLikePdfTool({ workspaceOnly: false });
    expect(
      opened.ok,
      `workspaceOnly=false should open <state>/canvas/doc.pdf; got: ${opened.detail}`,
    ).toBe(true);
    expect(opened.detail).toContain("%PDF-1.4");
  });

  it("F5.5b setting present: with tools.fs.workspaceOnly=true the same file outside the workspace is denied (the setting is what controls it)", async () => {
    const denied = await openLikePdfTool({ workspaceOnly: true });
    record("F5.5b workspaceOnly=true denial text", denied.detail);
    expect(denied.ok, "workspaceOnly=true must deny a file outside the workspace").toBe(false);
    expect(denied.detail).toMatch(/not under an allowed directory/);
  });

  // ---------------------------------------------------------------- what the model / the user are shown
  it("F5.6 a throwing pdf tool wrapped by toToolDefinitions returns {status:'error', tool:'pdf', error} to the model immediately", async () => {
    const { toToolDefinitions } = await import("../../src/agents/agent-tool-definition-adapter.js");
    const tool = await createRealPdfTool();
    const [definition] = toToolDefinitions([tool as never]);
    expect(definition, "tool definition").toBeDefined();
    const startedAt = performance.now();
    const result = await definition!.execute(
      "f5-model-visible",
      { prompt: "summarize", pdf: wall.url("/private/model.pdf") },
      undefined,
      undefined,
      {} as never,
    );
    const ms = performance.now() - startedAt;
    const details = result.details as
      | { status?: string; tool?: string; error?: string }
      | undefined;
    record("F5.6 model-visible result", { details, text: JSON.stringify(result.content) });
    expect(ms, `model waited ${Math.round(ms)} ms`).toBeLessThan(SHORT_MS);
    expect(details?.status).toBe("error");
    expect(details?.tool).toBe("pdf");
    expect(details?.error).toMatch(/\b401\b/);
    expect(JSON.stringify(result.content)).toMatch(/\b401\b/);
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("F5.6b the user-facing warning for a failed pdf call (no reply produced) carries a reason or next step", async () => {
    const { buildFailureWarning } =
      await import("../../src/agents/embedded-agent-runner/run/tool-error-warning.js");
    const tool = await createRealPdfTool();
    const outside = await writeFakePdf(elsewhereDir, "warn.pdf");
    const failures = [
      (await callPdfExpectFailure(tool, wall.url("/private/warn.pdf"))).message,
      (await callPdfExpectFailure(tool, outside)).message,
    ];
    const missing: string[] = [];
    for (const error of failures) {
      const warning = buildFailureWarning({
        lastToolError: { toolName: "pdf", error },
        hasUserFacingReply: false,
        useMarkdown: false,
      } as never) as string | undefined;
      record("F5.6b default-verbosity user warning", warning ?? "(none)");
      const extra = (warning ?? "").replace(/^\s*⚠️?\s*PDF\s+failed\.?/i, "").trim();
      if (extra.length < 10) {
        missing.push(`warning="${warning}" for error="${error.slice(0, 80)}"`);
      }
    }
    expect(missing, `user only sees the bare label: ${missing.join(" | ")}`).toEqual([]);
  });

  it("F5.6c setting present: with verbose=full the user-facing warning includes the failure reason", async () => {
    const { buildFailureWarning } =
      await import("../../src/agents/embedded-agent-runner/run/tool-error-warning.js");
    const tool = await createRealPdfTool();
    const failed = await callPdfExpectFailure(tool, wall.url("/private/verbose.pdf"));
    const warning = buildFailureWarning({
      lastToolError: { toolName: "pdf", error: failed.message },
      hasUserFacingReply: false,
      verboseLevel: "full",
      useMarkdown: false,
    } as never) as string | undefined;
    record("F5.6c verbose=full user warning", warning ?? "(none)");
    expect(warning ?? "").toMatch(/\b401\b/);
  });

  // ---------------------------------------------------------------- (1)/(3) no retry loop: loop protection
  it("F5.7 default config (tools.loopDetection not set): 25 identical failing pdf calls are stopped before all 25 reach the origin", async () => {
    const run = await circleWithRealPdfTool({
      cfg: {},
      calls: 25,
      argsFor: () => wall.url("/private/same.pdf"),
    });
    record("F5.7 default config, 25 identical 401 calls", {
      originHits: run.originHits,
      blockedAtCall: run.firstBlocked + 1 || "never",
      kinds: run.kinds.join(","),
      loopEvents: run.loopEvents,
    });
    expect(
      run.firstBlocked,
      `no call was ever blocked; the origin was hit ${run.originHits} times by 25 identical failing calls`,
    ).toBeGreaterThanOrEqual(0);
    expect(run.originHits).toBeLessThan(25);
  });

  it("F5.8 setting present: with tools.loopDetection.enabled=true identical failing pdf calls are blocked (critical) by the 21st call", async () => {
    const run = await circleWithRealPdfTool({
      cfg: { tools: { loopDetection: { enabled: true } } },
      calls: 25,
      argsFor: () => wall.url("/private/same-enabled.pdf"),
    });
    record("F5.8 enabled=true, 25 identical 401 calls", {
      originHits: run.originHits,
      blockedAtCall: run.firstBlocked + 1 || "never",
      kinds: run.kinds.join(","),
      loopEvents: run.loopEvents,
    });
    expect(run.firstBlocked, "a loop block must happen").toBeGreaterThanOrEqual(0);
    expect(run.firstBlocked, "blocked at call number (0-based index)").toBeLessThanOrEqual(20);
    expect(run.originHits).toBeLessThanOrEqual(20);
  });

  it("F5.9 circling with VARYING URLs (12 different 401 URLs) is stopped or escalated within 10 failures, even with tools.loopDetection.enabled=true", async () => {
    const tool = await createRealPdfTool();
    const variants: Array<{ args: unknown; error: Error }> = [];
    for (let i = 1; i <= 12; i += 1) {
      const url = wall.url(`/share/v${i}/report.pdf`);
      const failed = await callPdfExpectFailure(tool, url);
      variants.push({ args: { prompt: "summarize", pdf: url }, error: failed.error });
    }
    const verdicts = await replayThroughDetector(variants, { enabled: true });
    record("F5.9 verdict per call (12 distinct 401 URLs, enabled=true)", verdicts.join(","));
    const firstEscalation = verdicts.findIndex((verdict) => verdict !== "ok");
    expect(
      firstEscalation,
      `never warned or blocked across 12 failing calls with varied URLs: ${verdicts.join(",")}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      firstEscalation,
      "escalation must come by the 11th call (after 10 failures)",
    ).toBeLessThanOrEqual(10);
  });

  // ---------------------------------------------------------------- (1) no hang
  it("F5.10 an origin that accepts the request but never answers is failed back to the model within 2 minutes", async () => {
    vi.useFakeTimers();
    try {
      const { loadWebMediaRaw } = await import("../../src/media/web-media.js");
      const stalled = vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const rejectForAbort = () =>
              reject(
                signal?.reason instanceof Error ? signal.reason : new Error("request aborted"),
              );
            if (signal?.aborted) {
              rejectForAbort();
              return;
            }
            signal?.addEventListener("abort", rejectForAbort, { once: true });
          }),
      );
      const startedAt = Date.now();
      let settledAfterMs: number | undefined;
      let failure: unknown;
      // The exact options the pdf tool passes (pdf-tool.ts): maxBytes, localRoots, readIdleTimeoutMs (120 s, http only),
      // ssrfPolicy. It passes no timeoutMs / responseHeaderTimeoutMs, so the media layer default applies.
      const call = loadWebMediaRaw("https://93.184.216.34/stalled.pdf", {
        maxBytes: 10 * 1024 * 1024,
        localRoots: [],
        readIdleTimeoutMs: 120_000,
        fetchImpl: stalled as never,
      } as never).then(
        () => {
          settledAfterMs = Date.now() - startedAt;
        },
        (error: unknown) => {
          settledAfterMs = Date.now() - startedAt;
          failure = error;
        },
      );
      for (let minute = 1; minute <= 20 && settledAfterMs === undefined; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
      }
      record("F5.10 stalled origin", {
        fetchAttempts: stalled.mock.calls.length,
        failedAfterSeconds:
          settledAfterMs === undefined ? "never (within 20 min)" : settledAfterMs / 1000,
        error: failure instanceof Error ? failure.message : String(failure),
      });
      if (settledAfterMs !== undefined) {
        await call;
      }
      expect(
        settledAfterMs,
        `the model waits ${settledAfterMs === undefined ? ">20 min" : `${settledAfterMs / 1000} s`} for an origin that never answers`,
      ).toBeDefined();
      expect(settledAfterMs as number).toBeLessThanOrEqual(120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------------------------------------------------------------- records of current behaviour
  it("F5.11 (record) varied-argument circling today: what the loop detector reports for cycles of 3 URLs / 12 local paths / identical texts", async () => {
    const tool = await createRealPdfTool();
    const urls = [1, 2, 3].map((n) => wall.url(`/cycle/c${n}.pdf`));
    const urlFailures = new Map<string, Error>();
    for (const url of urls) {
      urlFailures.set(url, (await callPdfExpectFailure(tool, url)).error);
    }
    // (a) the model cycles over 3 URLs, 8 rounds = 24 calls (realistic error text embeds each URL)
    const cycle = Array.from({ length: 24 }, (_, i) => {
      const url = urls[i % 3]!;
      return { args: { prompt: "summarize", pdf: url }, error: urlFailures.get(url)! };
    });
    record(
      "F5.11a 3-URL cycle x8, enabled=true",
      (await replayThroughDetector(cycle, { enabled: true })).join(","),
    );

    // (b) 12 different local paths outside allowed roots, one attempt each
    const pathVariants: Array<{ args: unknown; error: Error }> = [];
    for (let i = 1; i <= 12; i += 1) {
      const file = await writeFakePdf(path.join(elsewhereDir, `v${i}`), "report.pdf");
      pathVariants.push({
        args: { prompt: "summarize", pdf: file },
        error: (await callPdfExpectFailure(tool, file)).error,
      });
    }
    record(
      "F5.11b 12 distinct denied paths, enabled=true",
      (await replayThroughDetector(pathVariants, { enabled: true })).join(","),
    );

    // (c) hypothetical: same error TEXT for 12 distinct argument sets (as if the message did not embed the URL)
    const sameText = Array.from({ length: 12 }, (_, i) => ({
      args: { prompt: "summarize", pdf: wall.url(`/share/t${i}/report.pdf`) },
      error: new Error("HTTP 401 Unauthorized"),
    }));
    record(
      "F5.11c 12 distinct args, identical error text, enabled=true",
      (await replayThroughDetector(sameText, { enabled: true })).join(","),
    );

    // (d) the same 12 URL failures with the default (unset) config
    record(
      "F5.11d default config (loopDetection unset)",
      (await replayThroughDetector(pathVariants, undefined)).join(","),
    );

    // (e) is a loop WARNING visible to the model when the tool throws? (wrapper appends warnings to results only)
    const run = await circleWithRealPdfTool({
      cfg: { tools: { loopDetection: { enabled: true } } },
      calls: 14,
      argsFor: () => wall.url("/private/warn-visible.pdf"),
    });
    record(
      "F5.11e enabled=true, 14 identical failing calls: loop diagnostics emitted",
      run.loopEvents,
    );
    record(
      "F5.11e enabled=true: error text the caller got at calls 10..14",
      run.messages.slice(9).map((m) => m.slice(0, 160)),
    );
    expect(run.kinds.length).toBe(14);

    // (f) control for the replay harness: IDENTICAL calls must warn at call 11, as the wrapper run (e) does.
    const identical = Array.from({ length: 14 }, () => ({
      args: { prompt: "summarize", pdf: urls[0] },
      error: urlFailures.get(urls[0]!)!,
    }));
    const control = await replayThroughDetector(identical, { enabled: true });
    record(
      "F5.11f control: 14 identical failing calls through the detector replay, enabled=true",
      control.join(","),
    );
    expect(control[10], "harness check: identical calls warn on the 11th").toMatch(
      /^warning:generic_repeat/,
    );
  });
});

// ------------------------------------------------------------------------------------ helpers (need wall/state)

/** Mirrors the document-load step of the pdf tool (pdf-tool.ts: resolveMediaToolReferenceAccess + loadWebMediaRaw). */
async function openLikePdfTool(params: {
  workspaceOnly: boolean;
}): Promise<{ ok: boolean; detail: string }> {
  const { resolveEffectiveToolFsWorkspaceOnly } =
    await import("../../src/agents/tool-fs-policy.js");
  const { resolveMediaToolReferenceAccess } =
    await import("../../src/agents/tools/media-tool-shared.js");
  const { loadWebMediaRaw } = await import("../../src/media/web-media.js");
  // The user-facing setting is tools.fs.workspaceOnly; resolve it exactly like the tool wiring does (agent-tools.ts).
  const cfg = { tools: { fs: { workspaceOnly: params.workspaceOnly } } } as never;
  const fsPolicy = { workspaceOnly: resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" }) };
  const workspaceDir = await makeTempDir("f5-ws-");
  // <state>/canvas is one of the default allowed roots (src/media/local-roots.ts); the file is NOT in the workspace.
  const file = await writeFakePdf(
    path.join(stateDir, "canvas"),
    `doc-${params.workspaceOnly ? "on" : "off"}.pdf`,
  );
  try {
    const { resolvedPath, localRoots } = await resolveMediaToolReferenceAccess({
      input: file,
      isDataUrl: false,
      workspaceDir,
      fsPolicy,
    } as never);
    const media = await loadWebMediaRaw(
      resolvedPath as string,
      {
        maxBytes: 10 * 1024 * 1024,
        localRoots,
        workspaceDir,
      } as never,
    );
    return { ok: true, detail: media.buffer.toString("utf8") };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

type PdfToolLike = { execute: (...args: any[]) => Promise<any> };
type CircleKind = "error" | "blocked" | "ok";

/** The real pdf tool wrapped like production (before_tool_call wrapper + resolved tools.loopDetection config). */
async function circleWithRealPdfTool(params: {
  cfg: Record<string, unknown>;
  calls: number;
  argsFor: (index: number) => string;
}): Promise<{
  kinds: CircleKind[];
  firstBlocked: number;
  originHits: number;
  messages: string[];
  loopEvents: string[];
}> {
  const { onDiagnosticEvent } = await import("../../src/infra/diagnostic-events.js");
  const { wrapToolWithBeforeToolCallHook } =
    await import("../../src/agents/agent-tools.before-tool-call.js");
  const { resolveToolLoopDetectionConfig } =
    await import("../../src/agents/tool-loop-detection-config.js");
  const tool = await createRealPdfTool();
  const loopDetection = resolveToolLoopDetectionConfig({
    cfg: params.cfg as never,
    agentId: "main",
  });
  const sessionKey = `f5-circle-${Math.random().toString(36).slice(2)}`;
  const wrapped = wrapToolWithBeforeToolCallHook(
    tool as never,
    {
      agentId: "main",
      sessionKey,
      ...(loopDetection ? { loopDetection } : {}),
    } as never,
  ) as unknown as PdfToolLike;
  const hitsBefore = wall.hitCount();
  const kinds: CircleKind[] = [];
  const messages: string[] = [];
  const loopEvents: string[] = [];
  let callIndex = 0;
  const stopListening = onDiagnosticEvent((event) => {
    const loop = event as {
      type?: string;
      sessionKey?: string;
      level?: string;
      action?: string;
      detector?: string;
      count?: number;
    };
    if (loop.type === "tool.loop" && loop.sessionKey === sessionKey) {
      loopEvents.push(
        `call${callIndex + 1}:${loop.level}/${loop.action}/${loop.detector}/${loop.count}`,
      );
    }
  });
  for (let i = 0; i < params.calls; i += 1) {
    callIndex = i;
    try {
      const result = await wrapped.execute(
        `circle-${i}`,
        { prompt: "summarize", pdf: params.argsFor(i) },
        undefined,
        undefined,
      );
      const details = (result?.details ?? {}) as { status?: string; deniedReason?: string };
      kinds.push(
        details.status === "blocked" && details.deniedReason === "tool-loop" ? "blocked" : "ok",
      );
      messages.push(JSON.stringify(result?.content ?? "").slice(0, 400));
    } catch (error) {
      kinds.push("error");
      messages.push(error instanceof Error ? error.message : String(error));
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve)); // diagnostic events are delivered asynchronously
  stopListening();
  return {
    kinds,
    firstBlocked: kinds.indexOf("blocked"),
    originHits: wall.hitCount() - hitsBefore,
    messages,
    loopEvents,
  };
}

/** Feeds a sequence of failed pdf calls through the loop detector (detect -> record call -> record outcome). */
async function replayThroughDetector(
  calls: Array<{ args: unknown; error: Error }>,
  config: { enabled?: boolean } | undefined,
): Promise<string[]> {
  const { detectToolCallLoop, recordToolCall, recordToolCallOutcome } =
    await import("../../src/agents/tool-loop-detection.js");
  const state = { lastActivity: Date.now(), state: "processing", queueDepth: 0 } as never;
  const verdicts: string[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const verdict = detectToolCallLoop(state, "pdf", call.args, config as never) as {
      stuck: boolean;
      level?: string;
      detector?: string;
    };
    verdicts.push(verdict.stuck ? `${verdict.level}:${verdict.detector}` : "ok");
    if (verdict.stuck && verdict.level === "critical") {
      // A blocked call is not executed; the real wrapper records a veto, not a failure outcome.
      continue;
    }
    recordToolCall(state, "pdf", call.args, `replay-${i}`);
    recordToolCallOutcome(state, {
      toolName: "pdf",
      toolParams: call.args,
      toolCallId: `replay-${i}`,
      error: call.error,
    });
  }
  return verdicts;
}
