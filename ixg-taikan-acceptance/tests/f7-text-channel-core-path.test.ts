// F7 (core path): do the signals the reference reporter relies on really arrive from core, on A and B?
//
// Real path, fake model (see f7-text-channel-core-path.support.ts):
//   scripted fake LLM -> REAL agent session loop + fake tools -> REAL subscribe tool handlers
//   -> REAL createAgentRunEventHandler -> reply options (= the reporter's callbacks) <- REAL runReplyAgent
// Fake timers move the clock while a fake tool is blocked; the (fake) text channel records what the customer would see.
// Streams that the fake loop cannot produce (approval / compaction / command_output as raw agent events) are fed
// straight into the REAL event handler (createAgentRunEventHandler) instead — said so in the test names.
// Where A (2026.9.6+patches) and B (2026.9.7) differ in what core emits, the difference is written to
// out/f7-records-<tree>.log and noted in the test.
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Register the harness mocks before the runner (and the support file) are imported.
await vi.hoisted(async () => {
  await import("../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js");
});

import { registerAgentSessionLoopTestLifecycle } from "../../src/agents/sessions/agent-session-loop-correctness.test-support.js";
import { createAgentRunEventHandler } from "../../src/auto-reply/reply/agent-runner-event-handler.js";
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
import { createRig, leaky, leaksIn } from "./f7-text-channel-progress.support.js";

setupAgentRunnerTestHooks();
registerAgentSessionLoopTestLifecycle();

const sec = (n: number) => n * 1000;
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;
const tree = path.basename(process.cwd());

function record(key: string, value: unknown) {
  const dir = process.env.IXG_TAIKAN_RECORD_DIR ?? os.tmpdir();
  try {
    appendFileSync(path.join(dir, `f7-records-${tree}.log`), `${JSON.stringify({ key, value })}\n`);
  } catch {
    // records are best-effort
  }
}

const TOOL_ARGS = { path: leaky.path, url: leaky.url, command: leaky.command };
const FAILURE = new Error(
  `ENOENT: no such file ${leaky.path}; GET ${leaky.url} -> 401 (Authorization: Bearer sk-live-0123456789abcdef0123456789)`,
);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-05T13:00:00Z"), toFake: [...FAKE_TIMERS] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("F7.8 real core path: a slow tool, then another, then the final reply", () => {
  it("F7.8 label after the gate, 'still running' tick with elapsed, phase change, silence after completion", async () => {
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
    const rig = createRig();
    const { opts, cap } = captureReplyOptions(rig.o);
    rig.reporter.start();
    const done = createEmbeddedRun(opts).run();

    await until(() => probe.toolsStarted.includes("pdf"), "pdf tool started");
    expect(rig.texts()).toEqual([]); // inside the gate
    await vi.advanceTimersByTimeAsync(1_500);
    expect(rig.texts()).toEqual(["PDFを読み取り中です。"]);

    await vi.advanceTimersByTimeAsync(sec(30)); // -> 31.5 s; silence tick due at 26.5 s
    expect(rig.sent.map((s) => [s.at, s.text])).toEqual([
      [1_500, "PDFを読み取り中です。"],
      [26_500, "まだ処理中です（PDFを読み取り中・経過26秒）"],
    ]);

    pdf.resolve();
    await until(() => probe.toolsStarted.includes("web_search"), "web_search tool started");
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.texts().at(-1)).toBe("Web検索中です。"); // phase change = a NEW message (31.5 s >= 26.5 s + minGap)

    search.resolve();
    const result = await done;
    await settle();
    expect(payloadTexts(result)).toEqual(["完了しました。"]);
    expect(cap.terminal).toEqual(["completed"]);
    const countAtEnd = rig.sent.length;
    await vi.advanceTimersByTimeAsync(sec(300)); // terminal outcome received: no tick races the final reply
    expect(rig.sent).toHaveLength(countAtEnd);
    expect(leaksIn(rig.texts())).toEqual([]);
    rig.reporter.stop();
  });

  it("F7.8b a quick turn (tool done before the gate) shows nothing at all", async () => {
    const probe = installFakeEmbeddedRun({
      turns: [
        { calls: [{ id: "c1", name: "memory_search", args: { query: "経費" } }] },
        { text: "はい。" },
      ],
      tools: { memory_search: {} },
    });
    const rig = createRig();
    rig.reporter.start();
    const result = await createEmbeddedRun(captureReplyOptions(rig.o).opts).run();
    await settle();
    expect(probe.toolsStarted).toEqual(["memory_search"]);
    expect(payloadTexts(result)).toEqual(["はい。"]);
    await vi.advanceTimersByTimeAsync(sec(120));
    expect(rig.texts()).toEqual([]);
    rig.reporter.stop();
  });
});

describe("F7.9 real core path: a tool fails", () => {
  it("F7.9 the run continues: failure named at once (tool + 'what next'), no raw error, final reply untouched", async () => {
    const probe = installFakeEmbeddedRun({
      turns: [
        { calls: [{ id: "call-pdf", name: "pdf", args: TOOL_ARGS }] },
        { text: "PDFを開けませんでした。別の資料を送ってください。" },
      ],
      tools: { pdf: { throws: FAILURE } },
    });
    const rig = createRig();
    const { opts, cap } = captureReplyOptions(rig.o);
    rig.reporter.start();
    const result = await createEmbeddedRun(opts).run();
    await settle();
    expect(probe.toolsStarted).toEqual(["pdf"]);
    expect(rig.sent.map((s) => [s.at, s.text])).toEqual([
      [0, "PDFの読み取りで失敗しました。別の方法を試します。"],
    ]); // at once, not after the 1.5 s gate
    expect(leaksIn(rig.texts())).toEqual([]);
    expect(payloadTexts(result)).toEqual(["PDFを開けませんでした。別の資料を送ってください。"]);
    expect(cap.terminal).toEqual(["completed"]);
    // contract on the live path: the failed item reaches onItemEvent with tool name + failed status ...
    const failed = cap.item.find((p) => p.phase === "end" && p.status === "failed");
    expect(failed).toMatchObject({
      kind: "tool",
      name: "pdf",
      toolCallId: "call-pdf",
      itemId: "tool:call-pdf",
    });
    // ... and the event handler drops the raw error / timestamps (agent-runner-event-handler.ts), so nothing raw can leak from them
    expect(Object.keys(failed ?? {})).not.toContain("error");
    expect(Object.keys(failed ?? {})).not.toContain("startedAt");
    expect(Object.keys(failed ?? {})).not.toContain("endedAt");
    rig.reporter.stop();
  });

  it("F7.9b (record) item title/meta ARE built from args on the live path (path, url, command) -> the reporter must not use them", async () => {
    installFakeEmbeddedRun({
      turns: [{ calls: [{ id: "call-pdf", name: "pdf", args: TOOL_ARGS }] }, { text: "ok" }],
      tools: { pdf: {} },
    });
    const rig = createRig();
    const { opts, cap } = captureReplyOptions(rig.o);
    rig.reporter.start();
    await createEmbeddedRun(opts).run();
    await settle();
    const start = cap.item.find((p) => p.phase === "start");
    const joined = JSON.stringify([start, cap.toolStart[0]]);
    record("itemStartTitleMeta", {
      title: start?.title,
      meta: start?.meta,
      toolStartKeys: Object.keys(cap.toolStart[0] ?? {}),
    });
    // core only masks secrets (sanitizeToolArgs); paths/URLs/commands stay in args/title/meta
    expect(joined).toContain("internal.example");
    expect(joined).toContain("/home/sparx");
    expect(leaksIn(rig.texts())).toEqual([]);
    rig.reporter.stop();
  });

  it("F7.9c the run ends with no reply: core's final is the English '⚠️ PDF failed' (isError); the reporter supplies the Japanese final wording", async () => {
    installFakeEmbeddedRun({
      turns: [{ calls: [{ id: "call-pdf", name: "pdf", args: TOOL_ARGS }] }, { text: "" }],
      tools: { pdf: { throws: FAILURE } },
    });
    const rig = createRig();
    const { opts, cap } = captureReplyOptions(rig.o);
    rig.reporter.start();
    const result = await createEmbeddedRun(opts).run();
    await settle();
    const payloads = (Array.isArray(result) ? result : [result]) as Array<{
      text?: string;
      isError?: boolean;
    }>;
    record("noReplyFinal", {
      payloads: payloads.map((p) => ({ text: p.text, isError: p.isError })),
      terminal: cap.terminal,
    });
    expect(payloads.map((p) => p.text)).toEqual(["⚠️ PDF failed"]); // no path, no reason, English, no "what next"
    expect(payloads[0]?.isError).toBe(true);
    // the tool failure was already announced; the plugin replaces core's English final with the reporter's wording
    expect(rig.texts()).toEqual(["PDFの読み取りで失敗しました。別の方法を試します。"]);
    expect(rig.reporter.finalFailureText()).toBe(
      "処理を完了できませんでした。失敗した箇所: PDFの読み取り。依頼の内容やファイル・URLをご確認のうえ、もう一度お試しください。",
    );
    expect(leaksIn([rig.reporter.finalFailureText()])).toEqual([]);
    rig.reporter.stop();
  });

  it("F7.9d the model run itself fails after a tool failure: terminal 'failed' -> one final-failure message naming the last failed place", async () => {
    installFakeEmbeddedRun({
      turns: [{ calls: [{ id: "call-fetch", name: "web_fetch", args: TOOL_ARGS }] }, { text: "" }],
      tools: { web_fetch: { throws: FAILURE } },
      failAfter: new Error(`provider unavailable at ${leaky.url}`),
    });
    const rig = createRig();
    const { opts, cap } = captureReplyOptions(rig.o);
    rig.reporter.start();
    const result = await createEmbeddedRun(opts).run();
    await settle();
    expect(cap.terminal).toContain("failed");
    expect(rig.texts()).toEqual([
      "Webページの取得で失敗しました。別の方法を試します。",
      "処理を完了できませんでした。失敗した箇所: Webページの取得。依頼の内容やファイル・URLをご確認のうえ、もう一度お試しください。",
    ]);
    expect(rig.reporter.terminalFailureSent).toBe(true);
    expect(leaksIn(rig.texts())).toEqual([]);
    record("runFailedFinal", { texts: payloadTexts(result) });
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(rig.texts()).toHaveLength(2);
    rig.reporter.stop();
  });

  it("F7.9e exec with a non-zero exit (what core calls failed): quiet the first time, reported when it repeats; output/cwd never shown", async () => {
    const details = {
      status: "completed",
      exitCode: 2,
      durationMs: 12,
      cwd: "/home/sparx/customers/acme",
      aggregated: `grep: ${leaky.path}: No such file`,
    };
    installFakeEmbeddedRun({
      turns: [
        { calls: [{ id: "e1", name: "exec", args: { command: leaky.command } }] },
        { calls: [{ id: "e2", name: "exec", args: { command: leaky.command } }] },
        { text: "確認できませんでした。" },
      ],
      tools: { exec: { details, text: details.aggregated } },
    });
    const rig = createRig();
    const { opts, cap } = captureReplyOptions(rig.o);
    rig.reporter.start();
    await createEmbeddedRun(opts).run();
    await settle();
    // live-path contract: core marks the item failed (projectAgentActivityItem) and sends command_output with exitCode
    expect(
      cap.item.filter((p) => p.name === "exec" && p.phase === "end").map((p) => p.status),
    ).toEqual(["failed", "failed"]);
    // the live path sends two 'end' command outputs per exec: one projected from the tool result (no exit code) and the
    // command_output stream event (exitCode); the reporter counts the failure once per toolCallId
    expect(
      cap.commandOutput
        .filter((p) => p.phase === "end" && p.exitCode !== undefined)
        .map((p) => p.exitCode),
    ).toEqual([2, 2]);
    expect(rig.texts()).toEqual(["処理の実行で失敗が続いています（2回目）。別の方法を試します。"]);
    expect(leaksIn(rig.texts())).toEqual([]);
    rig.reporter.stop();
  });

  it("F7.9f progress_card (the model's own plan) reaches onPlanUpdate and names the step in the failure; the progress_card tool itself is never announced", async () => {
    installFakeEmbeddedRun({
      turns: [
        {
          calls: [
            {
              id: "pc1",
              name: "progress_card",
              args: {
                plan: [
                  { step: "請求書を読む", status: "in_progress" },
                  { step: "金額を集計する", status: "pending" },
                ],
              },
            },
          ],
        },
        { calls: [{ id: "f1", name: "web_fetch", args: TOOL_ARGS }] },
        { text: "取得できませんでした。" },
      ],
      tools: { progress_card: {}, web_fetch: { throws: FAILURE } },
    });
    const rig = createRig();
    const { opts, cap } = captureReplyOptions(rig.o);
    rig.reporter.start();
    await createEmbeddedRun(opts).run();
    await settle();
    expect(cap.plan[0]).toMatchObject({
      phase: "update",
      steps: [
        { step: "請求書を読む", status: "in_progress" },
        { step: "金額を集計する", status: "pending" },
      ],
    });
    expect(rig.texts()).toEqual([
      "手順1/2「請求書を読む」の途中、Webページの取得で失敗しました。別の方法を試します。",
    ]);
    rig.reporter.stop();
  });
});

describe("F7.10 live-path contract of what the reporter reads (A and B)", () => {
  it("F7.10 onToolStart / onItemEvent carry toolCallId, name, phase, status, kind on both trees; item end carries the outcome", async () => {
    const gate = createDeferred();
    const probe = installFakeEmbeddedRun({
      turns: [{ calls: [{ id: "c1", name: "web_search", args: { query: "x" } }] }, { text: "ok" }],
      tools: { web_search: { gate: gate.promise } },
    });
    const rig = createRig();
    const { opts, cap } = captureReplyOptions(rig.o);
    rig.reporter.start();
    const done = createEmbeddedRun(opts).run();
    await until(() => probe.toolsStarted.length === 1, "tool started");
    await settle();
    gate.resolve();
    await done;
    await settle();
    expect(cap.toolStart[0]).toMatchObject({
      toolCallId: "c1",
      name: "web_search",
      phase: "start",
    });
    expect(cap.toolStart[0]?.args).toEqual({ query: "x" });
    const kinds = cap.item.map((p) => `${p.name}:${p.phase}:${p.status}`);
    expect(kinds).toContain("web_search:start:running");
    expect(kinds).toContain("web_search:end:completed");
    for (const p of cap.item.filter((i) => i.name === "web_search")) {
      expect(p).toMatchObject({ kind: "tool", toolCallId: "c1" });
    }
    // A vs B: B re-emits hidden copies of finished activity at agent end (finalizeToolActivity); A does not. The reporter ignores hidden items.
    const hidden = cap.item.filter((p) => p.hideFromChannelProgress === true).length;
    record("hiddenItemsAfterRun", { hidden, total: cap.item.length });
    expect(rig.texts().every((t) => !t.includes("web_search"))).toBe(true);
    rig.reporter.stop();
  });
});

describe("F7.11 raw agent events fed to the REAL event handler (streams the fake loop cannot produce)", () => {
  function realHandler(reporterOpts: Record<string, unknown>) {
    const captured = captureReplyOptions(reporterOpts);
    const handler = createAgentRunEventHandler({
      turn: {
        opts: captured.opts,
        sessionCtx: { Provider: "telegram", MessageSid: "msg" },
        typingSignals: { signalToolStart: async () => {} },
        replyOperation: undefined,
        toolProgressDetail: "explain",
      },
      lifecycleBackstop: { note: () => {} },
      notifyAgentRunStart: () => {},
      sourceRepliesAreToolOnly: false,
      provider: "anthropic",
      model: "claude",
      runId: "run-1",
      notifyUserAboutCompaction: false,
      onCompactionCompleted: () => 1,
      messageToolDeliveryState: { toolCallIds: new Set(), completed: false },
    } as never);
    return { handler, ...captured };
  }

  it("F7.11 compaction start/end, approval pending/denied (with a raw command), command_output end: mapped fields are what the reporter reads", async () => {
    const rig = createRig();
    const { handler, cap } = realHandler(rig.o);
    rig.reporter.start();
    await handler({ stream: "compaction", data: { phase: "start" } } as never);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(rig.texts()).toEqual(["会話の履歴を整理中です。"]);
    await handler({ stream: "compaction", data: { phase: "end", completed: true } } as never);
    await handler({
      stream: "approval",
      data: {
        phase: "requested",
        kind: "exec",
        status: "pending",
        title: "Command approval requested",
        toolCallId: "e1",
        approvalId: "ap1",
        command: leaky.command,
        host: "gateway",
      },
    } as never);
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(rig.texts().at(-1)).toBe("操作の許可を待機中です。");
    await handler({
      stream: "approval",
      data: {
        phase: "resolved",
        kind: "exec",
        status: "denied",
        title: "Command approval resolved",
        toolCallId: "e1",
        message: leaky.path,
      },
    } as never);
    await handler({
      stream: "command_output",
      data: {
        itemId: "command:e9",
        phase: "end",
        title: "command x",
        toolCallId: "e9",
        name: "exec",
        output: leaky.path,
        status: "failed",
        exitCode: 126,
        durationMs: 5,
        cwd: "/home/sparx",
      },
    } as never);
    expect(cap.compactionStart).toBe(1);
    expect(cap.approval.map((a) => [a.phase, a.status])).toEqual([
      ["requested", "pending"],
      ["resolved", "denied"],
    ]);
    expect(cap.approval[0]?.command).toBe(leaky.command); // core hands the raw command; the reporter must not read it
    expect(cap.commandOutput[0]).toMatchObject({
      phase: "end",
      status: "failed",
      exitCode: 126,
      name: "exec",
      toolCallId: "e9",
    });
    expect(rig.texts().slice(-2)).toEqual([
      "処理の実行は許可が得られず実行できませんでした。別の方法を試します。", // approval denied
      "処理の実行で失敗が続いています（2回目）。別の方法を試します。", // then exit code 126 (2nd exec failure in a row)
    ]);
    expect(leaksIn(rig.texts())).toEqual([]);
    rig.reporter.stop();
  });

  it("F7.11b hidden / non-tool items pass through the handler with their flags and are ignored by the reporter", async () => {
    const rig = createRig();
    const { handler, cap } = realHandler(rig.o);
    rig.reporter.start();
    for (const data of [
      {
        itemId: "tool:p1",
        toolCallId: "p1",
        kind: "tool",
        name: "progress_card",
        phase: "start",
        status: "running",
        title: "Progress",
        hideFromChannelProgress: true,
      },
      {
        itemId: "tool:p2",
        toolCallId: "p2",
        kind: "tool",
        name: "pdf",
        phase: "end",
        status: "failed",
        title: "PDF",
        suppressChannelProgress: true,
      },
      {
        itemId: "pre",
        kind: "preamble",
        title: "text",
        phase: "update",
        status: "running",
        progressText: `${leaky.path} を開きます`,
      },
      { kind: "status", title: "Fast", phase: "update", summary: "Fast mode off" },
    ]) {
      await handler({ stream: "item", data } as never);
    }
    await vi.advanceTimersByTimeAsync(sec(3));
    expect(cap.item.map((p) => p.kind)).toEqual(["tool", "tool", "preamble", "status"]);
    expect(cap.item[0]?.hideFromChannelProgress).toBe(true);
    expect(cap.item[1]?.suppressChannelProgress).toBe(true);
    expect(rig.texts()).toEqual(["考え中です。"]); // nothing but the thinking placeholder
    rig.reporter.stop();
  });
});
