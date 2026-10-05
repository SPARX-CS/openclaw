// F7 (board): reference/text-channel-progress-board.ts in isolation. The board has no sender and no timer: the plugin's own
// timer calls board.render(key, now) when it is about to push. Core-shaped payloads are fed through attach().replyOptions;
// a manual clock keeps every expectation exact. (The plugin-timer replica is in f7-plugin-timer-board.test.ts, the real core
// path in f7-text-channel-core-path.test.ts.)
import { describe, expect, it } from "vitest";
import {
  boardRef,
  commandOutputEnd,
  itemEvent,
  leaksIn,
  leaky,
  toolStart,
} from "./f7-text-channel-progress.support.js";

const sec = (n: number) => n * 1000;
const KEY = "acct\u0000lineworks:user:u1";

function setup(over: Parameters<typeof boardRef.createProgressBoard>[0] = {}) {
  let t = 0;
  const board = boardRef.createProgressBoard({ now: () => t, ...over });
  return {
    board,
    at: (ms: number) => void (t = ms),
    /** an attached dispatch whose model run has started */
    run: (key = KEY) => {
      const a = board.attach(key);
      a.replyOptions.onAgentRunStart?.("run-1");
      return a;
    },
  };
}

describe("F7.17 board: what render() says (current stage, Japanese, customer-safe)", () => {
  it("F7.17 unknown -> null: no key, attached with no signal yet, after detach", () => {
    const { board } = setup();
    expect(board.render(KEY)).toBeNull();
    const a = board.attach(KEY);
    expect(board.has(KEY)).toBe(true);
    expect(board.render(KEY)).toBeNull(); // the run may still wait in a lane: say nothing, the plugin keeps its template
    a.detach();
    expect(board.has(KEY)).toBe(false);
    expect(board.render(KEY)).toBeNull();
  });

  it("F7.17b a running tool: 'PDFを読み取り中です（経過45秒）'; the model thinking: '考え中です（経過30秒）'", () => {
    const s = setup();
    const a = s.run();
    expect(s.board.render(KEY, sec(30))).toBe("考え中です（経過30秒）"); // run started, no tool yet
    s.at(sec(3));
    a.replyOptions.onToolStart?.(toolStart("pdf", "c1"));
    expect(s.board.render(KEY, sec(48))).toBe("PDFを読み取り中です（経過45秒）");
    s.at(sec(50));
    a.replyOptions.onItemEvent?.(itemEvent("pdf", "c1", "end", "completed"));
    expect(s.board.render(KEY, sec(80))).toBe("考え中です（経過30秒・全体1分20秒）"); // thinking again; its clock restarts when the tool ended
  });

  it("F7.17c the total since the first dispatch is added only when the stage began well after it", () => {
    const s = setup();
    const a = s.run();
    s.at(sec(40));
    a.replyOptions.onToolStart?.(toolStart("web_search", "c1"));
    expect(s.board.render(KEY, sec(70))).toBe("Web検索中です（経過30秒・全体1分10秒）");
    const quick = setup({ totalShownAfterMs: sec(60) });
    const b = quick.run();
    quick.at(sec(40));
    b.replyOptions.onToolStart?.(toolStart("web_search", "c1"));
    expect(quick.board.render(KEY, sec(70))).toBe("Web検索中です（経過30秒）");
  });

  it("F7.17d a failure while the run continues: the failed place + 'trying another way' while nothing new has started; a new tool replaces it; it does not come back", () => {
    const s = setup();
    const a = s.run();
    a.replyOptions.onToolStart?.(toolStart("pdf", "c1"));
    s.at(sec(5));
    a.replyOptions.onItemEvent?.(
      itemEvent("pdf", "c1", "end", "failed", { error: `ENOENT ${leaky.path}` }),
    );
    expect(s.board.render(KEY, sec(30))).toBe(
      "PDFの読み取りで失敗しました。別の方法を試しています。（全体の経過30秒）",
    );
    s.at(sec(31));
    a.replyOptions.onToolStart?.(toolStart("web_search", "c2"));
    expect(s.board.render(KEY, sec(40))).toBe("Web検索中です（経過9秒・全体40秒）");
  });

  it("F7.17e after the new tool succeeded, thinking shows no stale failure", () => {
    const s = setup();
    const a = s.run();
    a.replyOptions.onItemEvent?.(itemEvent("pdf", "c1", "end", "failed"));
    s.at(sec(2));
    a.replyOptions.onToolStart?.(toolStart("web_search", "c2"));
    s.at(sec(8));
    a.replyOptions.onItemEvent?.(itemEvent("web_search", "c2", "end", "completed"));
    expect(s.board.render(KEY, sec(20))).toBe("考え中です（経過12秒）");
  });

  it("F7.17f the push-mode policy is reused: the 1st exec failure is routine and stays quiet, the 2nd is shown", () => {
    const s = setup();
    const a = s.run();
    a.replyOptions.onItemEvent?.(itemEvent("exec", "e1", "end", "failed"));
    a.replyOptions.onCommandOutput?.(commandOutputEnd("e1", 2, "failed"));
    expect(s.board.render(KEY, sec(10))).toBe("考え中です（経過10秒）");
    a.replyOptions.onCommandOutput?.(commandOutputEnd("e2", 127, "completed"));
    expect(s.board.render(KEY, sec(10))).toBe(
      "処理の実行で失敗が続いています（2回目）。別の方法を試しています。（全体の経過10秒）",
    );
    expect(leaksIn([s.board.render(KEY, sec(10)) ?? ""])).toEqual([]);
  });

  it("F7.17g plan step, approval wait and compaction are shown as the stage", () => {
    const s = setup();
    const a = s.run();
    a.replyOptions.onPlanUpdate?.({
      phase: "update",
      steps: [
        { step: "請求書を読む", status: "completed" },
        { step: "金額を集計する", status: "in_progress" },
      ],
    });
    expect(s.board.render(KEY, sec(12))).toBe("考え中です（手順2/2「金額を集計する」・経過12秒）");
    s.at(sec(20));
    a.replyOptions.onApprovalEvent?.({
      phase: "requested",
      kind: "exec",
      status: "pending",
      toolCallId: "e1",
      command: leaky.command,
    });
    expect(s.board.render(KEY, sec(32))).toBe(
      "操作の許可を待機中です（手順2/2「金額を集計する」・経過12秒・全体32秒）",
    );
    a.replyOptions.onApprovalEvent?.({
      phase: "resolved",
      kind: "exec",
      status: "approved",
      toolCallId: "e1",
    });
    s.at(sec(40));
    a.replyOptions.onCompactionStart?.();
    expect(s.board.render(KEY, sec(45))).toBe(
      "会話の履歴を整理中です（手順2/2「金額を集計する」・経過5秒・全体45秒）",
    );
  });

  it("F7.17h customer-safe: path / URL / command / token in plan text, tool names, titles, args, errors never appear; redact that throws -> null", () => {
    const s = setup();
    const a = s.run();
    a.replyOptions.onPlanUpdate?.({
      steps: [{ step: `${leaky.url} から ${leaky.path} を集計`, status: "in_progress" }],
    });
    a.replyOptions.onToolStart?.(toolStart(leaky.command, "h1"));
    a.replyOptions.onItemEvent?.(
      itemEvent("pdf", "h2", "end", "failed", { error: leaky.command, summary: leaky.url }),
    );
    const text = s.board.render(KEY, sec(10)) ?? "";
    expect(text).toContain("手順1/1「（URL） から （パス） を集計」");
    expect(leaksIn([text])).toEqual([]);
    const bad = setup({
      redact: () => {
        throw new Error("redact bug");
      },
    });
    bad.run().replyOptions.onToolStart?.(toolStart("pdf", "c1"));
    expect(bad.board.render(KEY, sec(10))).toBeNull();
  });

  it("F7.17i hidden items, preamble/status items and unknown payloads are ignored; labels can be overridden; unknown tools get the safe generic wording", () => {
    const s = setup({
      labelFor: (k) =>
        k === "crm_lookup" ? { doing: "顧客情報を検索中", where: "顧客情報の検索" } : undefined,
    });
    const a = s.run();
    a.replyOptions.onItemEvent?.(
      itemEvent("progress_card", "p1", "start", "running", { hideFromChannelProgress: true }),
    );
    a.replyOptions.onItemEvent?.({
      itemId: "pre",
      kind: "preamble",
      phase: "update",
      status: "running",
      progressText: leaky.path,
    });
    for (const g of [undefined, null, {}, { steps: "x" }, "s"]) {
      a.replyOptions.onToolStart?.(g as never);
      a.replyOptions.onItemEvent?.(g as never);
      a.replyOptions.onPlanUpdate?.(g as never);
    }
    expect(s.board.render(KEY, sec(5))).toBe("考え中です（経過5秒）");
    a.replyOptions.onToolStart?.(toolStart("crm_lookup", "c1"));
    expect(s.board.render(KEY, sec(5))).toBe("顧客情報を検索中です（経過5秒）");
    a.replyOptions.onToolStart?.(toolStart("lineworks_send_file", "c2"));
    expect(s.board.render(KEY, sec(5))).toBe("「lineworks_send_file」を実行中です（経過5秒）");
  });

  it("F7.17j the attachment's replyOptions: the whole set core needs, with suppressDefaultToolProgressMessages:true (without it verbose-off drops them)", () => {
    const { board } = setup();
    const ro = board.attach(KEY).replyOptions;
    expect(ro.suppressDefaultToolProgressMessages).toBe(true);
    for (const name of [
      "onAgentRunStart",
      "onAgentRunTerminalOutcome",
      "onToolStart",
      "onItemEvent",
      "onCommandOutput",
      "onPlanUpdate",
      "onApprovalEvent",
      "onCompactionStart",
      "onCompactionEnd",
    ] as const) {
      expect(typeof ro[name], name).toBe("function");
    }
  });
});

describe("F7.18 board: several dispatches on one key (the plugin shares one timer per conversation)", () => {
  it("F7.18 the most recently started stage wins; other keys are independent; the key is forgotten when the last dispatch detaches", () => {
    const s = setup();
    const a = s.run();
    a.replyOptions.onToolStart?.(toolStart("pdf", "a1"));
    s.at(sec(20));
    const b = s.run();
    s.at(sec(25));
    b.replyOptions.onToolStart?.(toolStart("web_search", "b1"));
    const other = s.run("acct\u0000lineworks:user:u2");
    other.replyOptions.onToolStart?.(toolStart("image_generate", "o1"));
    expect(s.board.render(KEY, sec(55))).toBe("Web検索中です（経過30秒・全体55秒）");
    expect(s.board.render("acct\u0000lineworks:user:u2", sec(55))).toBe(
      "画像を生成中です（経過30秒）",
    );
    b.detach();
    expect(s.board.render(KEY, sec(60))).toBe("PDFを読み取り中です（経過1分）"); // A's stage is the live one again
    expect(s.board.has(KEY)).toBe(true);
    a.detach();
    expect(s.board.has(KEY)).toBe(false);
    expect(s.board.render(KEY, sec(60))).toBeNull();
    expect(s.board.has("acct\u0000lineworks:user:u2")).toBe(true);
  });

  it("F7.18b events that arrive through a detached dispatch's options (the queued run uses the options of the dispatch that queued it) are taken over by the live one; with none alive they are dropped", () => {
    const s = setup();
    const queuer = s.run();
    const live = s.board.attach(KEY);
    queuer.detach();
    queuer.replyOptions.onAgentRunStart?.("run-2");
    queuer.replyOptions.onToolStart?.(toolStart("memory_search", "q1"));
    expect(s.board.render(KEY, sec(7))).toBe("記憶を検索中です（経過7秒）");
    live.detach();
    expect(() => queuer.replyOptions.onToolStart?.(toolStart("pdf", "q2"))).not.toThrow();
    expect(s.board.has(KEY)).toBe(false);
  });

  it("F7.18c a run that ended shows nothing; when the same options start the next run (queued message) the board follows it", () => {
    const s = setup();
    const a = s.run();
    a.replyOptions.onToolStart?.(toolStart("pdf", "c1"));
    a.replyOptions.onAgentRunTerminalOutcome?.("completed");
    expect(s.board.render(KEY, sec(5))).toBeNull();
    s.at(sec(6));
    a.replyOptions.onAgentRunStart?.("run-2"); // the queued run
    a.replyOptions.onToolStart?.(toolStart("web_fetch", "c2"));
    expect(s.board.render(KEY, sec(16))).toBe("Webページを取得中です（経過10秒）");
  });

  it("F7.18d render() never throws and never mutates: repeated calls give the same text", () => {
    const s = setup();
    const a = s.run();
    a.replyOptions.onToolStart?.(toolStart("pdf", "c1"));
    const first = s.board.render(KEY, sec(5));
    for (let i = 0; i < 5; i += 1) {
      expect(s.board.render(KEY, sec(5))).toBe(first);
    }
    expect(s.board.render("", sec(5))).toBeNull();
  });
});
