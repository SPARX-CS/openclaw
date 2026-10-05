// F5: tool failures (acceptance tests for the "bot circled around a failing pdf tool for 6.5 minutes" type).
//
// Production case: the pdf tool was given (a) a URL that needs auth (HTTP 401) and (b) a local path outside
// the allowed locations. The bot retried with varied URLs/paths for 6.5 minutes and the user only saw "processing".
//
// Desired behavior asserted here (each `it` states the DESIRED behavior; FAIL = not passing on that version):
//   (1) a tool failure comes back to the model quickly, understandably, without a hang or retry loop;
//   (2) the error / guidance shows how to open it (authenticated fetch, or the setting for allowed locations);
//   (3) when it cannot be opened, the model is told to switch approach or tell the user (F5b: failure hint from the
//       Nth consecutive failure of the same tool + failure kind, whatever the arguments; hint only, never a block).
//
// Items deliberately NOT changed by the F5 fix are kept as "(unchanged by design: <reason>)" and RECORD the current
// behaviour instead of asserting a desired one: F5.2b (header forwarding), F5.6b (user warning text), F5.7
// (tools.loopDetection stays off by default), F5.10 (the 15-minute header wait is not shortened: slow is not failure).
//
// Seams (all version-stable, hermetic): the REAL pdf tool (src/agents/tools/pdf-tool.ts) driven up to the document
// load, against a loopback 401 server (127.0.0.1 only) or real temp dirs; wrapToolWithBeforeToolCallHook +
// toToolDefinitions with one hook context (= what the embedded runner hands the model; F5.8b, F5.9*);
// buildFailureWarning (what the user sees); resolveToolLoopDetectionConfig (loop protection as wired in production);
// detectToolCallLoop/recordToolCall* (loop detector API).
// The model infra (complete / completeSimple, which differs between 9.6 and 9.7) is never reached.
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_GUIDANCE,
  PATH_REMEDY,
  JAPANESE,
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

  it("F5.3 a local path outside the allowed locations is rejected quickly; the rejection says where it failed (the path itself is not repeated)", async () => {
    const tool = await createRealPdfTool();
    const outside = await writeFakePdf(elsewhereDir, "report.pdf");
    const failed = await callPdfExpectFailure(tool, outside);
    record("F5.3 denied-path error text", failed.message);
    expect(failed.ms, `denial took ${Math.round(failed.ms)} ms`).toBeLessThan(SHORT_MS);
    expect(failed.message).toContain("pdf ツール");
    expect(failed.message).toContain("ローカルファイルの読み取り");
    expect(failed.message, "the denied path is not echoed back").not.toContain(outside);
    expect(failed.message, "the technical reason stays findable").toMatch(
      /not under an allowed directory/,
    );
  });

  // ---------------------------------------------------------------- (2) guidance on how to open it
  it("F5.2 the 401 error says how to open it (authenticated tool into the workspace) and what to ask the customer when none exists, in Japanese, naming tool and stage", async () => {
    const tool = await createRealPdfTool();
    const url = wall.url("/private/guide.pdf");
    const failed = await callPdfExpectFailure(tool, url);
    const guidance = guidanceTextOf(failed.message, [url]);
    record("F5.2 401 error text", failed.message);
    expect(
      AUTH_GUIDANCE.test(guidance),
      `no auth guidance in the 401 error; actual="${failed.message}"`,
    ).toBe(true);
    expect(failed.message).toMatch(JAPANESE);
    expect(failed.message, "where it failed: tool + stage").toContain(
      "pdf ツールで失敗しました（段階: URL の取得",
    );
    expect(failed.message).toContain("HTTP 401");
    expect(failed.message, "how to open it").toContain("認証付きで取得できる道具");
    expect(failed.message).toContain(
      "作業場（workspace）に保存し、作業場の中のパスを pdf ツールに渡す",
    );
    expect(failed.message, "what to ask the customer when no authenticated tool exists").toMatch(
      /利用者に.*添付.*共有設定を開く/,
    );
    expect(failed.message, "customer view rule").toContain(
      "利用者はこちらの内部の状況を知りません",
    );
  });

  it("F5.2b (unchanged by design: the pdf tool does not forward tools.web.fetch.headers; that key feeds web_fetch only) record: a configured Authorization header is not sent by the pdf fetch", async () => {
    const tool = await createRealPdfTool({
      webFetch: { headers: { Authorization: "Bearer f5-test-token" } },
    });
    const before = wall.hitCount();
    await callPdfExpectFailure(tool, wall.url("/private/with-header.pdf"));
    const sent = wall.authorizationHeaders().slice(before);
    // (Labels avoid the words that the repo's vitest reporter redacts as credentials.)
    record(
      "F5.2b origin saw",
      sent.map((value) => (value ? "a header" : "no auth header")),
    );
    // Deliberately unchanged: the pdf tool carries no credentials of its own.
    expect(sent, "exactly one fetch reached the origin").toHaveLength(1);
    expect(sent[0], "the pdf tool carries no Authorization header").toBeUndefined();
  });

  it("F5.4 the denied-path error lists the allowed roots the tool really enforces and a remedy (move/copy into the workspace, or ask the customer to attach the file)", async () => {
    const { resolveMediaToolReferenceAccess } =
      await import("../../src/agents/tools/media-tool-shared.js");
    const tool = await createRealPdfTool();
    const outside = await writeFakePdf(elsewhereDir, "guide.pdf");
    const failed = await callPdfExpectFailure(tool, outside);
    record("F5.4 denied-path error text", failed.message);
    const guidance = guidanceTextOf(failed.message, [outside]);
    expect(
      PATH_REMEDY.test(guidance),
      `no setting/remedy in the denied-path error; actual="${failed.message}"`,
    ).toBe(true);
    // The roots in the text are the roots resolution gives the tool (the same call the pdf tool makes).
    const { localRoots } = await resolveMediaToolReferenceAccess({
      input: outside,
      isDataUrl: false,
    } as never);
    expect(localRoots.length).toBeGreaterThan(1);
    for (const root of localRoots) {
      expect(failed.message, `allowed root ${root}`).toContain(root);
    }
    expect(failed.message).toContain(path.join(stateDir, "canvas"));
    expect(failed.message).toMatch(/許可されている場所: /);
    expect(failed.message, "remedy 1: move/copy into an allowed place").toContain(
      "移すかコピーして",
    );
    expect(failed.message, "remedy 2: ask the customer").toMatch(/利用者に.*添付を頼む/);
    expect(failed.message).toContain("利用者はこちらの内部の状況を知りません");
    expect(failed.message).not.toContain(outside);
  });

  it("F5.4b with tools.fs.workspaceOnly=true the listed roots shrink to the workspace (the list follows the real resolution)", async () => {
    const workspaceDir = await makeTempDir("f5-ws-roots-");
    const tool = await createRealPdfTool({ workspaceDir, fsPolicy: { workspaceOnly: true } });
    const outside = await writeFakePdf(elsewhereDir, "ws-only.pdf");
    const failed = await callPdfExpectFailure(tool, outside);
    record("F5.4b workspaceOnly=true denied-path error text", failed.message);
    expect(failed.message).toContain(`許可されている場所: ${workspaceDir}\n`);
    expect(failed.message, "default roots are not allowed (nor listed) here").not.toContain(
      path.join(stateDir, "canvas"),
    );
  });

  it("F5.13 every failure names the tool and the stage: URL fetch / local file access / content type", async () => {
    const workspaceDir = await makeTempDir("f5-ws-stage-");
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "not a pdf");
    const tool = await createRealPdfTool({ workspaceDir });
    const stages: Record<string, string> = {};
    stages.url = (await callPdfExpectFailure(tool, wall.url("/stage/a.pdf"))).message;
    stages.local = (
      await callPdfExpectFailure(tool, await writeFakePdf(elsewhereDir, "stage.pdf"))
    ).message;
    stages.missing = (
      await callPdfExpectFailure(tool, path.join(workspaceDir, "gone.pdf"))
    ).message;
    stages.type = (await callPdfExpectFailure(tool, "note.txt")).message;
    record("F5.13 stage texts", stages);
    expect(stages.url).toContain("pdf ツールで失敗しました（段階: URL の取得");
    expect(stages.local).toContain("pdf ツールで失敗しました（段階: ローカルファイルの読み取り）");
    expect(stages.missing).toContain(
      "pdf ツールで失敗しました（段階: ローカルファイルの読み取り）",
    );
    expect(stages.missing).toContain("指定のパスにファイルがありません");
    expect(stages.type).toContain("pdf ツールで失敗しました（段階: 内容の種類の確認）");
    expect(stages.type).toContain("PDF ではありませんでした（種類: text/plain）");
    for (const text of Object.values(stages)) {
      expect(text).toContain("利用者");
    }
  });

  it("F5.14 the texts are Japanese and carry no URL, host, query, origin body, credential or denied path", async () => {
    const tool = await createRealPdfTool({
      webFetch: { headers: { Authorization: "Bearer f5-test-token" } },
    });
    const url = wall.url("/priv/secret-doc-name.pdf?sig=f5-signature");
    const outside = await writeFakePdf(elsewhereDir, "secret-local-name.pdf");
    const texts = [
      (await callPdfExpectFailure(tool, url)).message,
      (await callPdfExpectFailure(tool, outside)).message,
    ];
    for (const text of texts) {
      expect(text).toMatch(JAPANESE);
      expect(text).not.toMatch(
        /https?:\/\/|127\.0\.0\.1|secret-doc-name|secret-local-name|f5-signature|f5-test-token|Bearer|nope/,
      );
    }
    // The model-visible error result adds nothing back either (operator hints stay out).
    const { toToolDefinitions } = await import("../../src/agents/agent-tool-definition-adapter.js");
    const [definition] = toToolDefinitions([tool as never]);
    const result = await definition!.execute(
      "f5-secret-check",
      { prompt: "summarize", pdf: url },
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /127\.0\.0\.1|secret-doc-name|f5-signature|f5-test-token|original error/,
    );
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

  it("F5.6b (unchanged by design: the default user warning stays the bare label; the reason is shown only with verbose=full) record: the user-facing warning for a failed pdf call", async () => {
    const { buildFailureWarning } =
      await import("../../src/agents/embedded-agent-runner/run/tool-error-warning.js");
    const tool = await createRealPdfTool();
    const outside = await writeFakePdf(elsewhereDir, "warn.pdf");
    const failures = [
      (await callPdfExpectFailure(tool, wall.url("/private/warn.pdf"))).message,
      (await callPdfExpectFailure(tool, outside)).message,
    ];
    for (const error of failures) {
      const warning = buildFailureWarning({
        lastToolError: { toolName: "pdf", error },
        hasUserFacingReply: false,
        useMarkdown: false,
      } as never) as string | undefined;
      record("F5.6b default-verbosity user warning", warning ?? "(none)");
      expect(warning ?? "").toMatch(/^\s*⚠️?\s*PDF\s+failed\.?\s*$/i);
    }
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
  it("F5.7 (unchanged by design: tools.loopDetection stays off by default; blocking is opt-in, the F5.9 hint is the default-on guard) record: with tools.loopDetection unset, 25 identical failing pdf calls are never blocked", async () => {
    const { resolveToolLoopDetectionConfig } =
      await import("../../src/agents/tool-loop-detection-config.js");
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
    expect(resolveToolLoopDetectionConfig({ cfg: {} as never, agentId: "main" })).toBeUndefined();
    expect(run.firstBlocked, "no call is blocked by default").toBe(-1);
    expect(run.originHits).toBe(25);
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

  it("F5.8b setting present, through the embedded path: with tools.loopDetection.enabled=true the 21st identical failing call is still blocked, and the failure hint comes from the 3rd failure on", async () => {
    const run = await circleThroughEmbeddedPath({
      cfg: { tools: { loopDetection: { enabled: true } } },
      urls: Array.from({ length: 25 }, () => wall.url("/private/same-embedded.pdf")),
    });
    record(
      "F5.8b embedded path, enabled=true, 25 identical 401 calls",
      run.calls.map((call) => `${call.status}${call.hint ? "+hint" : ""}`).join(","),
    );
    expect(run.calls.slice(0, 20).every((call) => call.status === "error")).toBe(true);
    expect(run.calls.slice(0, 20).map((call) => call.hint !== undefined)).toEqual(
      Array.from({ length: 20 }, (_, i) => i >= 2),
    );
    expect(run.calls[20]?.status, "the loop block still happens at the 21st call").toBe("blocked");
    expect(run.originHits).toBeLessThanOrEqual(20);
  });

  // ---- F5b: failure hint (hint only; same tool + same failure kind, whatever the arguments)
  describe.each([
    ["default config (tools.loopDetection unset)", {}],
    ["tools.loopDetection.enabled=true", { tools: { loopDetection: { enabled: true } } }],
  ] as const)("F5.9 varying URLs, %s", (_label, cfg) => {
    it("F5.9 12 DIFFERENT 401 URLs: the model gets a switch-or-tell-the-customer hint from the 3rd consecutive failure on, and no call is blocked", async () => {
      const run = await circleThroughEmbeddedPath({
        cfg: cfg as Record<string, unknown>,
        urls: Array.from({ length: 12 }, (_, i) => wall.url(`/share/v${i + 1}/report.pdf`)),
      });
      record(
        `F5.9 verdict per call (12 distinct 401 URLs, ${_label})`,
        run.calls.map((call) => `${call.status}${call.hint ? "+hint" : ""}`).join(","),
      );
      expect(
        run.calls.map((call) => call.hint !== undefined),
        "hint present per call",
      ).toEqual(Array.from({ length: 12 }, (_, i) => i >= 2));
      expect(
        run.calls.every((call) => call.status === "error"),
        "never blocked",
      ).toBe(true);
      expect(run.originHits, "every call still ran (hint only, nothing is stopped)").toBe(12);
    });
  });

  it("F5.9a the hint text: Japanese, says this way does not work and to switch or tell the customer, customer view rule, no URL/path/origin body, same wording whatever the arguments", async () => {
    const run = await circleThroughEmbeddedPath({
      cfg: {},
      urls: Array.from({ length: 5 }, (_, i) => wall.url(`/share/t${i}/secret-name.pdf`)),
    });
    const hints = run.calls.map((call) => call.hint).filter((hint): hint is string => !!hint);
    record("F5.9a hint at call 3", hints[0] ?? "(none)");
    expect(hints).toHaveLength(3);
    const text = hints[0]!;
    expect(text).toContain("この方法では取れていません");
    expect(text).toContain("別の方法に切り替えるか、利用者へ状況を伝えてください");
    expect(text).toContain("利用者はこちらの内部の状況を知りません");
    expect(text).toContain("何が足りないか");
    expect(text).toContain("何が問題か");
    expect(text).toContain("何を頼みたいか");
    expect(text).toContain("できない場合はその理由");
    expect(text).toContain("pdf ツール");
    expect(text).toContain("認証が必要・HTTP 401");
    expect(text).not.toMatch(/https?:\/\/|127\.0\.0\.1|secret-name|\/share\/|nope/);
    // Only the counter differs between calls: the wording does not depend on the arguments.
    expect(hints.map((hint) => hint.replace(/\d+ 回/, "N 回"))).toEqual(
      hints.map(() => text.replace(/\d+ 回/, "N 回")),
    );
    expect(hints.map((hint) => /(\d+) 回/.exec(hint)?.[1])).toEqual(["3", "4", "5"]);
  });

  it("F5.9b the threshold N is configurable: tools.failureHint.afterConsecutiveFailures = 1 and 5", async () => {
    const urls = Array.from({ length: 6 }, (_, i) => wall.url(`/cfg/v${i}.pdf`));
    const one = await circleThroughEmbeddedPath({
      cfg: { tools: { failureHint: { afterConsecutiveFailures: 1 } } },
      urls,
    });
    expect(one.calls.map((call) => call.hint !== undefined)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    const five = await circleThroughEmbeddedPath({
      cfg: { tools: { failureHint: { afterConsecutiveFailures: 5 } } },
      urls,
    });
    expect(five.calls.map((call) => call.hint !== undefined)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("F5.9c tools.failureHint.afterConsecutiveFailures = 0 disables the hint (12 failures, no hint, nothing blocked)", async () => {
    const run = await circleThroughEmbeddedPath({
      cfg: { tools: { failureHint: { afterConsecutiveFailures: 0 } } },
      urls: Array.from({ length: 12 }, (_, i) => wall.url(`/off/v${i}.pdf`)),
    });
    expect(run.calls.some((call) => call.hint !== undefined)).toBe(false);
    expect(run.calls.every((call) => call.status === "error")).toBe(true);
  });

  it("F5.9d the streak is per tool AND failure kind: 401 x2 + denied path x2 give no hint, the 3rd 401 does", async () => {
    const outside = await writeFakePdf(elsewhereDir, "kinds.pdf");
    const run = await circleThroughEmbeddedPath({
      cfg: {},
      urls: [
        wall.url("/k/1.pdf"),
        wall.url("/k/2.pdf"),
        outside,
        `${outside}.copy`,
        wall.url("/k/3.pdf"),
      ],
    });
    record(
      "F5.9d 401,401,denied,denied,401",
      run.calls.map((call) => `${call.status}${call.hint ? "+hint" : ""}`).join(","),
    );
    expect(run.calls.map((call) => call.hint !== undefined)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(run.calls[4]?.hint).toContain("認証が必要・HTTP 401");
  });

  it("F5.9e the streak resets on a success of the same tool, and one tool's failures do not count for another", async () => {
    const real = await createRealPdfTool();
    const failure = (await callPdfExpectFailure(real, wall.url("/reset/real.pdf"))).error;
    let succeedNext = false;
    const flaky = {
      name: "pdf",
      label: "PDF",
      description: "pdf stand-in that can succeed",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        if (succeedNext) {
          succeedNext = false;
          return { content: [{ type: "text", text: "summary" }], details: { status: "ok" } };
        }
        throw failure;
      },
    };
    const other = {
      name: "image",
      label: "Image",
      description: "image stand-in",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw failure;
      },
    };
    const { definitions } = await embeddedDefinitions([flaky, other], {});
    const call = async (index: number, name: string) => {
      const result = await definitions
        .find((definition) => definition.name === name)!
        .execute(`reset-${index}`, {}, undefined, undefined, {} as never);
      return readEmbeddedResult(result);
    };
    const trace: string[] = [];
    const step = async (name: string, succeed = false) => {
      succeedNext = succeed;
      const out = await call(trace.length, name);
      trace.push(`${name}:${out.status}${out.hint ? "+hint" : ""}`);
    };
    await step("pdf");
    await step("pdf");
    await step("pdf", true); // success: clears the pdf streak
    await step("pdf");
    await step("pdf");
    await step("image"); // other tool: its own count
    await step("pdf"); // 3rd failure since the success
    record("F5.9e trace", trace.join(" "));
    expect(trace).toEqual([
      "pdf:error",
      "pdf:error",
      "pdf:ok",
      "pdf:error",
      "pdf:error",
      "image:error",
      "pdf:error+hint",
    ]);
  });

  it("F5.9f a new run (a new customer message) starts a fresh count in the same session", async () => {
    const real = await createRealPdfTool();
    const failure = (await callPdfExpectFailure(real, wall.url("/run/real.pdf"))).error;
    const tool = {
      name: "pdf",
      label: "PDF",
      description: "always fails",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw failure;
      },
    };
    const sessionKey = `f5-run-scope-${Math.random().toString(36).slice(2)}`;
    const hints: boolean[] = [];
    for (const runId of ["run-a", "run-a", "run-b", "run-b"]) {
      const { definitions } = await embeddedDefinitions([tool], {}, { sessionKey, runId });
      const result = await definitions[0]!.execute(
        `scope-${hints.length}`,
        {},
        undefined,
        undefined,
        {} as never,
      );
      hints.push(readEmbeddedResult(result).hint !== undefined);
    }
    expect(hints, "2 failures in run-a, then 2 in run-b: never 3 in one run").toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("F5.12 config key tools.failureHint.afterConsecutiveFailures: schema accepts non-negative integers (0 = off), rejects junk, default is 3", async () => {
    const { validateConfigObject } = await import("../../src/config/validation.js");
    const { resolveToolFailureHintThreshold } =
      await import("../../src/agents/tool-loop-failure-hint.js");
    const validate = (failureHint: unknown) =>
      (validateConfigObject({ tools: { failureHint } }) as { ok: boolean }).ok;
    for (const good of [0, 1, 3, 10]) {
      expect(validate({ afterConsecutiveFailures: good }), `accepts ${good}`).toBe(true);
    }
    for (const bad of [-1, 1.5, "3", null, true]) {
      expect(validate({ afterConsecutiveFailures: bad }), `rejects ${String(bad)}`).toBe(false);
    }
    expect(validate({ afterConsecutiveFailures: 3, extra: 1 }), "strict: unknown key").toBe(false);
    expect(resolveToolFailureHintThreshold({} as never), "default").toBe(3);
    expect(
      resolveToolFailureHintThreshold({
        tools: { failureHint: { afterConsecutiveFailures: 0 } },
      } as never),
    ).toBe(0);
  });

  // ---------------------------------------------------------------- (1) no hang
  it("F5.10 (unchanged by design: timeouts are not shortened, slow is not failure) record: an origin that accepts the request but never answers still gets the 15-minute response-header wait", async () => {
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
      expect(settledAfterMs, "the stalled fetch settles within 20 minutes").toBeDefined();
      // The wait is the media layer's default header timeout (15 min); the F5 fix does not touch it.
      expect(settledAfterMs as number).toBeGreaterThanOrEqual(14 * 60_000);
      expect(settledAfterMs as number).toBeLessThanOrEqual(16 * 60_000);
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

type EmbeddedCall = { status: string; text: string; hint?: string };

function readEmbeddedResult(result: any): EmbeddedCall {
  const texts = ((result?.content ?? []) as Array<{ text?: string }>).map(
    (block) => block.text ?? "",
  );
  const hint = texts.find((text) => text.startsWith("[システム通知"));
  return {
    status: (result?.details?.status as string | undefined) ?? "ok",
    text: texts.join("\n"),
    ...(hint ? { hint } : {}),
  };
}

/**
 * What the embedded runner hands the model: each tool wrapped by the before_tool_call wrapper and then adapted by
 * toToolDefinitions, both with the same hook context (agent, session, run, the run's config, resolved loopDetection).
 */
async function embeddedDefinitions(
  tools: unknown[],
  cfg: Record<string, unknown>,
  ids?: { sessionKey?: string; runId?: string },
): Promise<{ definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> }> {
  const { wrapToolWithBeforeToolCallHook } =
    await import("../../src/agents/agent-tools.before-tool-call.js");
  const { toToolDefinitions } = await import("../../src/agents/agent-tool-definition-adapter.js");
  const { resolveToolLoopDetectionConfig } =
    await import("../../src/agents/tool-loop-detection-config.js");
  const loopDetection = resolveToolLoopDetectionConfig({ cfg: cfg as never, agentId: "main" });
  const sessionKey = ids?.sessionKey ?? `f5-embedded-${Math.random().toString(36).slice(2)}`;
  const hookContext = {
    agentId: "main",
    config: cfg,
    sessionKey,
    sessionId: `${sessionKey}-id`,
    runId: ids?.runId ?? "f5-run",
    ...(loopDetection ? { loopDetection } : {}),
  };
  const wrapped = tools.map((tool) =>
    wrapToolWithBeforeToolCallHook(tool as never, hookContext as never),
  );
  return { definitions: toToolDefinitions(wrapped as never, hookContext as never) as never };
}

/** One call per entry of `urls` on the real pdf tool, through the embedded wiring; reports what the model sees. */
async function circleThroughEmbeddedPath(params: {
  cfg: Record<string, unknown>;
  urls: string[];
}): Promise<{ calls: EmbeddedCall[]; originHits: number }> {
  const tool = await createRealPdfTool();
  const { definitions } = await embeddedDefinitions([tool], params.cfg);
  const hitsBefore = wall.hitCount();
  const calls: EmbeddedCall[] = [];
  for (const [index, pdf] of params.urls.entries()) {
    const result = await definitions[0]!.execute(
      `embedded-${index}`,
      { prompt: "summarize", pdf },
      undefined,
      undefined,
      {} as never,
    );
    calls.push(readEmbeddedResult(result));
  }
  return { calls, originHits: wall.hitCount() - hitsBefore };
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
