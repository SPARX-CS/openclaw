/**
 * 参照実装（pull 型）: plugin が**自前のタイマー**（LINE WORKS の intervalAck 等）で「処理中」を push している時に、
 * push する瞬間に「その会話のいまの段階」を読むための掲示板。**送信もタイマーも持たない**（core も plugin のタイマーも変えない）。
 *
 *   const board = createProgressBoard();                           // 会話をまたいで 1 つ（intervalAckStates と同じ寿命・同じ場所）
 *   const progress = board.attach(`${accountId}\0${to}`);          // dispatch ごとに 1 つ。key はタイマーと同じ（会話）
 *   await core.channel.inbound.dispatchReply({ ..., replyOptions: progress.replyOptions });
 *   // タイマー内: const text = board.render(key, Date.now()) ?? 固定の template;
 *   // finally:   progress.detach();
 *
 * 方針は push 型（text-channel-progress.ts）と同じ: 客に出すのは道具名のラベル・経過時間・手順番号・失敗箇所だけ。
 * title/meta/args/command/output/error は読まない。段階の追跡と失敗文の方針（連続失敗の間引き等）は createStageTracker を共有する。
 */
import {
  createStageTracker,
  formatElapsed,
  redactForCustomer,
  type StageTracker,
  type StageView,
  type TextProgressReplyOptions,
  type ToolLabel,
} from "./text-channel-progress.js";

export type ProgressBoardOptions = {
  now?: () => number;
  redact?: (text: string) => string;
  /** 小文字化した道具名 -> ラベル（既定の DEFAULT_TOOL_LABELS より優先）。 */
  labelFor?: (key: string) => ToolLabel | undefined;
  showPlanSteps?: boolean;
  /** 失敗が続いている間の「次」の言い方（既定は進行形）。 */
  nextAfterFailure?: string;
  /** 段階の経過とは別に「全体」の経過を出す最小の差（既定 10 秒）。 */
  totalShownAfterMs?: number;
};

export type ProgressAttachment = {
  /** core の replyOptions へ入れる（suppressDefaultToolProgressMessages:true を含む）。 */
  replyOptions: TextProgressReplyOptions;
  /** この dispatch を終える（plugin の finally で）。会話の最後の dispatch が終わると key は忘れられる。 */
  detach(): void;
};

export type ProgressBoard = {
  attach(key: string): ProgressAttachment;
  /** 会話のいまの段階を客向けの 1 行にする。何も分かっていなければ null（plugin は固定の template に戻す）。 */
  render(key: string, nowMs?: number): string | null;
  has(key: string): boolean;
};

type Att = { tracker: StageTracker; fail?: { text: string; at: number } };
type Entry = { firstAt: number; atts: Att[] };
type AnyFn = (...a: unknown[]) => unknown;

export function createProgressBoard(o: ProgressBoardOptions = {}): ProgressBoard {
  const now = o.now ?? Date.now;
  const redact = o.redact ?? redactForCustomer;
  const keys = new Map<string, Entry>();

  function attach(key: string): ProgressAttachment {
    const entry = keys.get(key) ?? { firstAt: now(), atts: [] };
    keys.set(key, entry);
    const att: Att = {
      tracker: createStageTracker({
        now,
        redact,
        labelFor: o.labelFor,
        showPlanSteps: o.showPlanSteps,
        nextAfterFailure: o.nextAfterFailure ?? "別の方法を試しています。",
        nextAfterFinalFailure: "",
        onNotice: (text, kind) => {
          if (kind === "failure") att.fail = { text, at: now() };
        },
        // 失敗の後、次の段階（別の道具・許可待ち等）が始まったら失敗の表示は役目を終える。「考え中」の間だけ失敗を見せ続ける。
        onChange: () => {
          if (att.fail && !att.tracker.view().idle) att.fail = undefined;
        },
      }),
    };
    entry.atts.push(att);
    // detach 後に届いたイベントは、同じ会話でいま生きている最新の dispatch が引き取る（queue に積まれたメッセージは、積んだ dispatch の
    // options で走る。その dispatch は先に終わっていることが多い）。生きている dispatch が無ければ捨てる。
    const target = (): Att | undefined =>
      entry.atts.includes(att) ? att : keys.get(key) === entry ? entry.atts.at(-1) : undefined;
    const forward = Object.fromEntries(
      Object.keys(att.tracker.callbacks).map((name) => [
        name,
        (...args: unknown[]) => {
          (target()?.tracker.callbacks as unknown as Record<string, AnyFn> | undefined)?.[name]?.(
            ...args,
          );
        },
      ]),
    );
    return {
      replyOptions: {
        suppressDefaultToolProgressMessages: true,
        ...forward,
      } as TextProgressReplyOptions,
      detach() {
        att.tracker.stop();
        const i = entry.atts.indexOf(att);
        if (i >= 0) entry.atts.splice(i, 1);
        if (!entry.atts.length && keys.get(key) === entry) keys.delete(key);
      },
    };
  }

  function render(key: string, nowMs: number = now()): string | null {
    try {
      const entry = keys.get(key);
      let best: { att: Att; v: StageView; stamp: number } | undefined;
      for (const att of entry?.atts ?? []) {
        const v = att.tracker.view();
        if (!v.seen || att.tracker.finished) continue; // まだ何も届いていない / 実行が終わった: 分からない
        const stamp = Math.max(v.since, att.fail?.at ?? -Infinity);
        if (!best || stamp >= best.stamp) best = { att, v, stamp }; // いちばん最近に始まった段階を採る
      }
      if (!entry || !best) return null;
      const { att, v } = best;
      const total = nowMs - entry.firstAt;
      const text = att.fail
        ? `${att.fail.text}（全体の経過${formatElapsed(total)}）` // 失敗の後、まだ次の段階が始まっていない（実行は続いている）
        : `${v.doing}です（${[v.step, `経過${formatElapsed(nowMs - v.since)}`, v.since - entry.firstAt >= (o.totalShownAfterMs ?? 10_000) ? `全体${formatElapsed(total)}` : ""].filter(Boolean).join("・")}）`;
      return redact(text) || null;
    } catch {
      return null; // 表示は best-effort。redact が失敗した文は出さず、plugin の template に戻す
    }
  }

  return { attach, render, has: (key) => keys.has(key) };
}
