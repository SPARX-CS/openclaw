// F7: customer-visible progress for a TEXT-ONLY channel (LINE WORKS style: messages can be sent, NOT edited).
//
// This file tests the reference module reference/text-channel-progress.ts in isolation: the reporter is fed
// exactly the payload shapes core hands to the reply options (see f7-text-channel-core-path.test.ts for the proof
// that the real core path produces these shapes on A and B). Fake timers only; no network, no key, no real channel.
// Each `it` asserts the DESIRED customer-facing behavior of the reference (not a core defect).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandOutputEnd,
  createRig,
  itemEvent,
  leaksIn,
  leaky,
  ref,
  toolStart,
} from "./f7-text-channel-progress.support.js";

const sec = (n: number) => n * 1000;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("F7.1 first status after a short gate, only while the turn is still running", () => {
  it("F7.1 nothing before 1.5 s; then the label of the running tool (Japanese, no internals)", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await o.onItemEvent?.(itemEvent("pdf", "c1", "start", "running"));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(texts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts()).toEqual(["PDFを読み取り中です。"]);
    reporter.stop();
  });

  it("F7.1b a turn that finishes before the gate never shows anything (no noise for quick answers)", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onItemEvent?.(itemEvent("read", "c1", "start", "running"));
    await vi.advanceTimersByTimeAsync(900);
    await o.onItemEvent?.(itemEvent("read", "c1", "end", "completed"));
    o.onAgentRunTerminalOutcome?.("completed");
    reporter.stop();
    await vi.advanceTimersByTimeAsync(sec(120));
    expect(texts()).toEqual([]);
  });

  it("F7.1c with no tool yet (model thinking only) the first status says it is thinking", async () => {
    const { reporter, texts } = createRig();
    reporter.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(texts()).toEqual(["考え中です。"]);
    reporter.stop();
  });

  it("F7.1d callbacks start the reporter lazily when the plugin forgot start()", async () => {
    const { reporter, o, texts } = createRig();
    await o.onToolStart?.(toolStart("web_search", "c1"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(texts()).toEqual(["Web検索中です。"]);
    reporter.stop();
  });
});

describe("F7.2 a NEW message when the phase changes (dedupe, throttle, coalesce)", () => {
  it("F7.2 phase change -> new message, but never closer than minGap (5 s) to the previous one", async () => {
    const { reporter, o, sent } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(1_500); // first status
    await o.onItemEvent?.(itemEvent("pdf", "c1", "end", "completed"));
    await vi.advanceTimersByTimeAsync(500); // t=2.0
    await o.onToolStart?.(toolStart("web_search", "c2"));
    await vi.advanceTimersByTimeAsync(4_499); // t=6.499 (< 1.5 + 5)
    expect(sent.map((s) => s.text)).toEqual(["PDFを読み取り中です。"]);
    await vi.advanceTimersByTimeAsync(1); // t=6.5
    expect(sent.map((s) => [s.at, s.text])).toEqual([
      [1_500, "PDFを読み取り中です。"],
      [6_500, "Web検索中です。"],
    ]);
    reporter.stop();
  });

  it("F7.2b a burst of phase changes inside the gap collapses to the latest phase", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(1_500);
    for (const [i, name] of ["web_search", "web_fetch", "browser", "image_generate"].entries()) {
      await o.onToolStart?.(toolStart(name, `b${i}`));
      await vi.advanceTimersByTimeAsync(400);
    }
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(texts()).toEqual(["PDFを読み取り中です。", "画像を生成中です。"]);
    reporter.stop();
  });

  it("F7.2c the same phase again is not repeated (identical text is deduped)", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("read", "r1"));
    await vi.advanceTimersByTimeAsync(1_500);
    for (let i = 2; i <= 6; i += 1) {
      await o.onItemEvent?.(itemEvent("read", `r${i - 1}`, "end", "completed"));
      await o.onToolStart?.(toolStart("read", `r${i}`));
      await vi.advanceTimersByTimeAsync(sec(3)); // 5 x 3 s = 15 s: inside the 25 s silence limit, so no tick either
    }
    expect(texts()).toEqual(["ファイルを読み取り中です。"]);
    reporter.stop();
  });

  it("F7.2d going back to thinking after a tool does not create a message (the tick covers it)", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(1_500);
    await o.onItemEvent?.(itemEvent("pdf", "c1", "end", "completed"));
    await vi.advanceTimersByTimeAsync(sec(10));
    expect(texts()).toEqual(["PDFを読み取り中です。"]);
    reporter.stop();
  });

  it("F7.2e plan steps from the model (progress_card -> onPlanUpdate) show as 手順 n/m with redacted text", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onPlanUpdate?.({
      phase: "update",
      title: "Plan updated",
      source: "openclaw",
      steps: [
        { step: "請求書を読む", status: "completed" },
        { step: `${leaky.url} から ${leaky.path} を集計する`, status: "in_progress" },
        { step: "報告書を作る", status: "pending" },
      ],
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatch(/^考え中です（手順2\/3「（URL） から （パス） を集計する」）。$/);
    expect(leaksIn(texts())).toEqual([]);
    reporter.stop();
  });

  it("F7.2f showPlanSteps:false keeps only the step number", async () => {
    const { reporter, o, texts } = createRig({ showPlanSteps: false });
    reporter.start();
    await o.onPlanUpdate?.({ steps: [{ step: "社外秘の計画", status: "in_progress" }] });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(texts()).toEqual(["考え中です（手順1/1）。"]);
    reporter.stop();
  });

  it("F7.2g compaction and approval waits are shown as their own phase", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onCompactionStart?.();
    await vi.advanceTimersByTimeAsync(1_500);
    await o.onCompactionEnd?.({ completed: true });
    await o.onApprovalEvent?.({
      phase: "requested",
      kind: "exec",
      status: "pending",
      toolCallId: "c9",
      command: leaky.command,
    });
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(texts()).toEqual(["会話の履歴を整理中です。", "操作の許可を待機中です。"]);
    expect(leaksIn(texts())).toEqual([]);
    reporter.stop();
  });

  it("F7.2h subagent_progress hook: started -> 別の担当が作業中, ended with error -> failure notice", async () => {
    const { reporter, texts } = createRig();
    reporter.start();
    reporter.noteSubagent({ phase: "started" });
    await vi.advanceTimersByTimeAsync(1_500);
    reporter.noteSubagent({ phase: "ended", outcome: "timeout" });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual([
      "別の担当が作業中です。",
      "別の担当への依頼で失敗しました。別の方法を試します。",
    ]);
    reporter.stop();
  });
});

describe("F7.3 periodic 'still running' tick with elapsed time", () => {
  it("F7.3 a long tool: tick after 25 s of silence, with elapsed time, formatted in Japanese", async () => {
    const { reporter, o, sent } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(sec(130));
    expect(sent.map((s) => [s.at, s.text])).toEqual([
      [1_500, "PDFを読み取り中です。"],
      [26_500, "まだ処理中です（PDFを読み取り中・経過26秒）"],
      [51_500, "まだ処理中です（PDFを読み取り中・経過51秒）"],
      [76_500, "まだ処理中です（PDFを読み取り中・経過1分16秒）"],
      [101_500, "まだ処理中です（PDFを読み取り中・経過1分41秒）"],
      [126_500, "まだ処理中です（PDFを読み取り中・経過2分06秒）"],
    ]);
    reporter.stop();
  });

  it("F7.3b thinking-only gap -> 考え中 tick (what core cannot show: there is no tool signal while the model thinks)", async () => {
    const { reporter, sent } = createRig();
    reporter.start();
    await vi.advanceTimersByTimeAsync(sec(60));
    expect(sent.map((s) => s.text)).toEqual([
      "考え中です。",
      "まだ処理中です（考え中・経過26秒）",
      "まだ処理中です（考え中・経過51秒）",
    ]);
    reporter.stop();
  });

  it("F7.3c the tick is silence-based: a phase message resets it (no message gap > tickMs, no tick right after a message)", async () => {
    const { reporter, o, sent } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(sec(20));
    await o.onToolStart?.(toolStart("web_search", "c2")); // phase change at 20 s -> message at 20 s
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(sent.map((s) => [s.at, s.text])).toEqual([
      [1_500, "PDFを読み取り中です。"],
      [20_000, "Web検索中です。"],
      [45_000, "まだ処理中です（Web検索中・経過45秒）"],
    ]);
    reporter.stop();
  });

  it("F7.3d tickMs / firstDelayMs / minGapMs are configurable", async () => {
    const { reporter, sent } = createRig({ tickMs: 10_000, firstDelayMs: 500 });
    reporter.start();
    await vi.advanceTimersByTimeAsync(sec(21));
    expect(sent.map((s) => [s.at, s.text])).toEqual([
      [500, "考え中です。"],
      [10_500, "まだ処理中です（考え中・経過10秒）"],
      [20_500, "まだ処理中です（考え中・経過20秒）"],
    ]);
    reporter.stop();
  });

  it("F7.3e a forgotten stop() ends itself after maxTotalMs (no eternal timers)", async () => {
    const { reporter, sent } = createRig({ maxTotalMs: sec(100) });
    reporter.start();
    await vi.advanceTimersByTimeAsync(sec(600));
    expect(sent.at(-1)!.at).toBeLessThanOrEqual(100_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("F7.4 failure: where (tool + step) and what happens next, immediately, no raw error text", () => {
  it("F7.4 a failed tool is reported at once (no gate), with the tool and what happens next", async () => {
    const { reporter, o, sent } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(300);
    await o.onItemEvent?.(
      itemEvent("pdf", "c1", "end", "failed", { error: `ENOENT ${leaky.path}` }),
    );
    expect(sent.map((s) => [s.at, s.text])).toEqual([
      [300, "PDFの読み取りで失敗しました。別の方法を試します。"],
    ]);
    reporter.stop();
  });

  it("F7.4b the failure names the plan step it happened in", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onPlanUpdate?.({
      steps: [
        { step: "請求書を読む", status: "in_progress" },
        { step: "集計する", status: "pending" },
      ],
    });
    await o.onItemEvent?.(itemEvent("web_fetch", "c1", "end", "failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual([
      "手順1/2「請求書を読む」の途中、Webページの取得で失敗しました。別の方法を試します。",
    ]);
    reporter.stop();
  });

  it("F7.4c exec: a non-zero exit seen as item(failed) AND command_output(exitCode) counts once; first one is quiet, the second is reported", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onItemEvent?.(itemEvent("exec", "e1", "end", "failed"));
    await o.onCommandOutput?.(commandOutputEnd("e1", 2, "failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual([]); // grep-style failures are routine: do not alarm the customer
    await o.onCommandOutput?.(commandOutputEnd("e2", 127, "completed")); // exit code alone (status says completed)
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["処理の実行で失敗が続いています（2回目）。別の方法を試します。"]);
    expect(leaksIn(texts())).toEqual([]);
    reporter.stop();
  });

  it("F7.4d repeated failures do not flood: 12 failures in a row -> notices only at 1, 2, 4, 8", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    for (let i = 1; i <= 12; i += 1) {
      await o.onItemEvent?.(itemEvent("pdf", `p${i}`, "end", "failed"));
      await vi.advanceTimersByTimeAsync(sec(1));
    }
    expect(texts()).toEqual([
      "PDFの読み取りで失敗しました。別の方法を試します。",
      "PDFの読み取りで失敗が続いています（2回目）。別の方法を試します。",
      "PDFの読み取りで失敗が続いています（4回目）。別の方法を試します。",
      "PDFの読み取りで失敗が続いています（8回目）。別の方法を試します。",
    ]);
    reporter.stop();
  });

  it("F7.4e a success in between resets the streak", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onItemEvent?.(itemEvent("pdf", "p1", "end", "failed"));
    await o.onItemEvent?.(itemEvent("pdf", "p2", "end", "completed"));
    await o.onItemEvent?.(itemEvent("pdf", "p3", "end", "failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual([
      "PDFの読み取りで失敗しました。別の方法を試します。",
      "PDFの読み取りで失敗しました。別の方法を試します。",
    ]);
    reporter.stop();
  });

  it("F7.4f blocked without approval id (approval unavailable, or the steering skip A reports as blocked) = not run; blocked WITH approval id = a wait, not a failure; an explicit approval denial says no permission", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onItemEvent?.(
      itemEvent("exec", "e1", "end", "blocked", {
        summary: "Command is blocked because no interactive approval route is available.",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["処理の実行は行われませんでした。別の方法を試します。"]);
    await o.onItemEvent?.(
      itemEvent("exec", "e2", "end", "blocked", { approvalId: "ap-1", approvalSlug: "abc" }),
    );
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(texts().at(-1)).toBe("操作の許可を待機中です。");
    await o.onApprovalEvent?.({
      phase: "resolved",
      kind: "exec",
      status: "denied",
      toolCallId: "e2",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts().at(-1)).toBe(
      "処理の実行は許可が得られず実行できませんでした。別の方法を試します。",
    );
    reporter.stop();
  });

  it("F7.4g the run ends in failure -> one final-failure message that names the last failed place; nothing after it", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onItemEvent?.(itemEvent("pdf", "c1", "end", "failed"));
    o.onAgentRunTerminalOutcome?.("failed");
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(texts()).toEqual([
      "PDFの読み取りで失敗しました。別の方法を試します。",
      "処理を完了できませんでした。失敗した箇所: PDFの読み取り。依頼の内容やファイル・URLをご確認のうえ、もう一度お試しください。",
    ]);
    expect(reporter.terminalFailureSent).toBe(true);
    expect(reporter.finalFailureText()).toContain("PDFの読み取り");
    reporter.stop();
  });

  it("F7.4h terminal 'completed' is not a latch: core calls 'failed' later when the final reply turns out empty (agent-runner-result-payloads.ts)", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    o.onAgentRunTerminalOutcome?.("completed");
    await vi.advanceTimersByTimeAsync(sec(60));
    expect(texts()).toEqual([]); // finished: no tick racing the final reply
    o.onAgentRunTerminalOutcome?.("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual([
      "処理を完了できませんでした。依頼の内容やファイル・URLをご確認のうえ、もう一度お試しください。",
    ]);
    reporter.stop();
  });

  it("F7.4i wording is configurable (what happens next)", async () => {
    const { reporter, o, texts } = createRig({
      nextAfterFailure: "担当者へ引き継ぎます。",
      nextAfterFinalFailure: "担当者が確認します。",
    });
    reporter.start();
    await o.onItemEvent?.(itemEvent("image_generate", "c1", "end", "failed"));
    o.onAgentRunTerminalOutcome?.("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual([
      "画像の生成で失敗しました。担当者へ引き継ぎます。",
      "処理を完了できませんでした。失敗した箇所: 画像の生成。担当者が確認します。",
    ]);
    reporter.stop();
  });
});

describe("F7.4j a second run on the same reply options (a queued message runs with the options of the dispatch that queued it)", () => {
  it("F7.4j after 'completed', the next onAgentRunStart on the same options resumes the reporter (ticks, failure memory reset) while it is kept alive; stop() still ends it for good", async () => {
    const { reporter, o, sent } = createRig();
    reporter.start();
    o.onAgentRunStart?.("run-1", undefined, undefined);
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(sec(2));
    o.onAgentRunTerminalOutcome?.("completed"); // msg 1 done: silence
    const afterFirst = sent.length;
    await vi.advanceTimersByTimeAsync(sec(60));
    expect(sent).toHaveLength(afterFirst);
    o.onAgentRunStart?.("run-2", undefined, undefined); // the queued run starts through the same options
    await o.onToolStart?.(toolStart("web_search", "c2"));
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(sent.slice(afterFirst).map((s) => s.text)).toEqual([
      "Web検索中です。",
      "まだ処理中です（Web検索中・経過1分27秒）",
    ]);
    reporter.stop();
    await vi.advanceTimersByTimeAsync(sec(120));
    expect(sent).toHaveLength(afterFirst + 2);
  });
});

describe("F7.5 labels", () => {
  it.each([
    ["read", "ファイルを読み取り中"],
    ["write", "ファイルを作成中"],
    ["edit", "ファイルを編集中"],
    ["apply_patch", "ファイルを編集中"],
    ["pdf", "PDFを読み取り中"],
    ["view_image", "画像を確認中"],
    ["image_generate", "画像を生成中"],
    ["music_generate", "音楽を生成中"],
    ["video_generate", "動画を生成中"],
    ["tts", "音声を作成中"],
    ["web_search", "Web検索中"],
    ["web_fetch", "Webページを取得中"],
    ["browser", "ブラウザで確認中"],
    ["exec", "処理を実行中"],
    ["bash", "処理を実行中"],
    ["memory_search", "記憶を検索中"],
    ["message", "メッセージを送信中"],
    ["sessions_spawn", "別の担当に作業を依頼中"],
    ["PDF", "PDFを読み取り中"],
  ])("F7.5 tool %s -> %s", async (name, doing) => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart(name, "c1"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(texts()).toEqual([`${doing}です。`]);
    reporter.stop();
  });

  it("F7.5b unknown tool -> safe generic wording with the tool name; odd/long names -> 別の作業", async () => {
    for (const [name, expected] of [
      ["lineworks_send_file", "「lineworks_send_file」を実行中です。"],
      ["x".repeat(40), "別の作業を実行中です。"],
      [`${leaky.path}`, "別の作業を実行中です。"],
      ["tool with spaces", "別の作業を実行中です。"],
    ] as const) {
      const { reporter, o, texts } = createRig();
      reporter.start();
      await o.onToolStart?.(toolStart(name, "c1"));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(texts()).toEqual([expected]);
      expect(leaksIn(texts())).toEqual([]);
      reporter.stop();
    }
  });

  it("F7.5c labels can be overridden / extended per deployment", async () => {
    const { reporter, o, texts } = createRig({
      labels: { crm_lookup: { doing: "顧客情報を検索中", where: "顧客情報の検索" } },
    });
    reporter.start();
    await o.onToolStart?.(toolStart("crm_lookup", "c1"));
    await o.onItemEvent?.(itemEvent("crm_lookup", "c1", "end", "failed"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(texts()).toEqual(["顧客情報の検索で失敗しました。別の方法を試します。"]);
    reporter.stop();
  });
});

describe("F7.6 customer-safe: no paths / URLs / commands / secrets, whatever core puts in args, titles, errors, output", () => {
  it("F7.6 hostile payloads on every callback never leak (title, meta, args, command, output, cwd, error, approval command, plan text)", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("exec", "e1"));
    await o.onItemEvent?.(itemEvent("exec", "e1", "start", "running"));
    await o.onPlanUpdate?.({
      steps: [
        {
          step: `curl -H "Authorization: Bearer sk-live-0123456789abcdef0123456789" ${leaky.url}`,
          status: "in_progress",
        },
      ],
      explanation: leaky.command,
    });
    await o.onApprovalEvent?.({
      phase: "requested",
      kind: "exec",
      status: "pending",
      toolCallId: "e1",
      command: leaky.command,
      reason: leaky.path,
      message: leaky.url,
    });
    await vi.advanceTimersByTimeAsync(sec(30));
    await o.onApprovalEvent?.({
      phase: "resolved",
      kind: "exec",
      status: "denied",
      toolCallId: "e1",
      message: leaky.path,
    });
    await o.onCommandOutput?.(commandOutputEnd("e1", 1, "failed"));
    await o.onItemEvent?.(
      itemEvent("exec", "e1", "end", "failed", {
        error: `${leaky.path} ${leaky.command}`,
        summary: leaky.url,
        progressText: leaky.path,
      }),
    );
    await o.onToolStart?.(toolStart("some_plugin_tool", "t2", { name: `${leaky.command}` }));
    await o.onToolStart?.(toolStart(`${leaky.url}`, "t3"));
    o.onAgentRunTerminalOutcome?.("failed");
    await vi.advanceTimersByTimeAsync(sec(60));
    expect(texts().length).toBeGreaterThan(3);
    expect(leaksIn(texts())).toEqual([]);
    for (const text of texts()) {
      expect(text).not.toMatch(/\/[\w.-]+\/[\w.-]+/); // nothing path-shaped
      expect(text).not.toMatch(/[A-Za-z0-9_+/=-]{24,}/); // nothing token-shaped
    }
    reporter.stop();
  });

  it.each([
    ["https://internal.example/api?token=abc を開く", "（URL） を開く"],
    ["/home/sparx/customers/acme/請求書.pdf を読む", "（パス） を読む"],
    ["~/Documents/q3-secret.xlsx を読む", "（パス） を読む"],
    ["./reports/2026/q3.pdf を読む", "（パス） を読む"],
    ["reports/2026/q3.pdf を読む", "（パス） を読む"],
    ["C:\\Users\\sparx\\q3.xlsx を読む", "（パス） を読む"],
    ["`rm -rf /tmp/work` を実行", "（省略） を実行"],
    ["$ curl -s https://x.example/a", "（省略）"],
    ["curl -H x https://x.example を実行", "（省略）"],
    ["Authorization: Bearer abcdefghij を付ける", "（認証情報） を付ける"],
    ["api_key=ABCDEF123 を使う", "（認証情報） を使う"],
    ["sk-live-0123456789abcdef を使う", "（認証情報） を使う"],
    ["0123456789abcdef0123456789abcdef を使う", "（省略） を使う"],
    ["2026/10/05 の売上と 入力/出力 を確認", "2026/10/05 の売上と 入力/出力 を確認"], // ordinary text stays
    ["売上を集計して報告書を作る", "売上を集計して報告書を作る"],
  ])("F7.6b redactForCustomer(%j) -> %j", (input, expected) => {
    expect(ref.redactForCustomer(input)).toBe(expected);
  });

  it("F7.6c a custom redact that throws fails closed: the message is dropped, the reporter keeps working", async () => {
    let calls = 0;
    const { reporter, o, texts } = createRig({
      redact: (t) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("redact bug");
        }
        return t;
      },
    });
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(texts()).toEqual([]);
    await o.onItemEvent?.(itemEvent("pdf", "c1", "end", "failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["PDFの読み取りで失敗しました。別の方法を試します。"]);
    reporter.stop();
  });

  it("F7.6d internal items are ignored: hideFromChannelProgress, suppressChannelProgress, preamble (model prose), status (Fast)", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onItemEvent?.(
      itemEvent("progress_card", "h1", "start", "running", { hideFromChannelProgress: true }),
    );
    await o.onItemEvent?.(
      itemEvent("pdf", "h2", "end", "failed", { hideFromChannelProgress: true }),
    );
    await o.onItemEvent?.(
      itemEvent("pdf", "h3", "end", "failed", { suppressChannelProgress: true }),
    );
    await o.onItemEvent?.({
      itemId: "pre-1",
      kind: "preamble",
      title: "text",
      phase: "update",
      status: "running",
      progressText: `${leaky.path} を開きます`,
    });
    await o.onItemEvent?.({
      itemId: "fast-mode-auto:off",
      kind: "status",
      title: "Fast",
      phase: "update",
      summary: "Fast mode off",
    });
    await o.onItemEvent?.(itemEvent("pdf", "h4", "end", "skipped"));
    await o.onItemEvent?.(itemEvent("pdf", "h5", "end", undefined, { summary: "Outcome unknown" }));
    await vi.advanceTimersByTimeAsync(sec(10));
    expect(texts()).toEqual(["考え中です。"]);
    reporter.stop();
  });
});

describe("F7.7 stop(), single in-flight send, best-effort sending", () => {
  it("F7.7 nothing is sent after stop(): pending timers, queued failures, late callbacks, even start() again", async () => {
    const { reporter, o, texts } = createRig();
    reporter.start();
    await o.onToolStart?.(toolStart("pdf", "c1"));
    await vi.advanceTimersByTimeAsync(1_500);
    await o.onToolStart?.(toolStart("web_search", "c2")); // would be sent at 6.5 s
    reporter.stop();
    expect(vi.getTimerCount()).toBe(0);
    await o.onItemEvent?.(itemEvent("web_search", "c2", "end", "failed"));
    o.onAgentRunTerminalOutcome?.("failed");
    reporter.noteToolFailure({ name: "pdf", toolCallId: "z" });
    reporter.start();
    await vi.advanceTimersByTimeAsync(sec(600));
    expect(texts()).toEqual(["PDFを読み取り中です。"]);
  });

  it("F7.7b stop() while a send is in flight: that send finishes, nothing follows", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { reporter, o, texts } = createRig({}, () => gate);
    reporter.start();
    await o.onItemEvent?.(itemEvent("pdf", "c1", "end", "failed"));
    await vi.advanceTimersByTimeAsync(0);
    await o.onItemEvent?.(itemEvent("web_fetch", "c2", "end", "failed")); // queued behind the in-flight one
    reporter.stop();
    release();
    await vi.advanceTimersByTimeAsync(sec(120));
    expect(texts()).toEqual(["PDFの読み取りで失敗しました。別の方法を試します。"]);
  });

  it("F7.7c at most one send in flight: a slow send holds back the next message until it resolves", async () => {
    const releases: Array<() => void> = [];
    const { reporter, o, sent, maxInFlight } = createRig(
      {},
      () => new Promise<void>((r) => releases.push(r)),
    );
    reporter.start();
    await o.onItemEvent?.(itemEvent("pdf", "c1", "end", "failed"));
    await o.onItemEvent?.(itemEvent("web_fetch", "c2", "end", "failed"));
    await o.onItemEvent?.(itemEvent("image_generate", "c3", "end", "failed"));
    await vi.advanceTimersByTimeAsync(sec(60)); // far beyond tick/gap: still only the first is out
    expect(sent.map((s) => s.text)).toEqual(["PDFの読み取りで失敗しました。別の方法を試します。"]);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(3);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(sec(1));
    expect(maxInFlight()).toBe(1);
    reporter.stop();
  });

  it("F7.7d send failures (reject or sync throw) are swallowed and later messages still go out", async () => {
    let n = 0;
    const seen: string[] = [];
    const reporter = ref.createTextProgressReporter({
      send: ((text: string) => {
        n += 1;
        seen.push(text);
        if (n === 1) {
          return Promise.reject(new Error("LINE WORKS 429"));
        }
        if (n === 2) {
          throw new Error("sync boom");
        }
        return Promise.resolve();
      }) as (text: string) => Promise<void>,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      reporter.start();
      const o = reporter.replyOptions;
      await o.onItemEvent?.(itemEvent("pdf", "c1", "end", "failed"));
      await vi.advanceTimersByTimeAsync(0);
      await o.onItemEvent?.(itemEvent("web_fetch", "c2", "end", "failed"));
      await vi.advanceTimersByTimeAsync(0);
      await o.onItemEvent?.(itemEvent("image_generate", "c3", "end", "failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(sec(30)); // ticks still work
      expect(seen.length).toBeGreaterThan(3);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      reporter.stop();
    }
  });

  it("F7.7e the callbacks never throw into core and return nothing that could be read as 'not visible'", async () => {
    const { reporter, o } = createRig();
    reporter.start();
    const garbage = [
      undefined,
      null,
      {},
      { phase: 7 },
      { steps: "x" },
      { status: {} },
      "str",
    ] as never[];
    for (const g of garbage) {
      for (const cb of [
        o.onToolStart,
        o.onItemEvent,
        o.onCommandOutput,
        o.onPlanUpdate,
        o.onApprovalEvent,
      ] as Array<(p: never) => unknown>) {
        expect(await cb(g)).toBeUndefined();
      }
    }
    expect(o.onCompactionStart?.()).toBeUndefined();
    expect(o.onCompactionEnd?.({ completed: false })).toBeUndefined();
    expect(o.suppressDefaultToolProgressMessages).toBe(true);
    reporter.stop();
  });
});
