/**
 * 参照実装: 「メッセージは送れるが編集できない」テキスト専用チャネル（例: LINE WORKS の自作 plugin）向けの
 * 「いま何を処理中か／まだ動いているか／どこで失敗したか」の表示。core を変えず、core が既に出す信号だけを使う。
 *
 *   const progress = createTextProgressReporter({ send: (t) => lineWorks.sendText(room, t) });
 *   progress.start();
 *   try {
 *     await core.channel.inbound.dispatch({ ..., replyOptions: { ...progress.replyOptions } });
 *   } finally { progress.stop(); }
 *
 * 方針: 客に見せるのは「道具名から引いた日本語ラベル」「経過時間」「手順番号」だけ。title / meta / summary / args /
 * command / output / cwd / error（パス・URL・コマンドを含み得る）は一切読まない。最後に全送信文へ redact を掛ける。
 * 表示のみで、timeout・再試行・core の挙動は変えない。表示は best-effort（送信失敗は握りつぶす）。
 */
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";

type Arg<K extends keyof GetReplyOptions> =
  NonNullable<GetReplyOptions[K]> extends (a: infer A, ...rest: never[]) => unknown ? A : never;

/** doing: 「〜中」（進行中の表示用）／ where: 「〜」（失敗箇所の表示用）／ failAfter: 連続何回目の失敗から知らせるか */
export type ToolLabel = { doing: string; where: string; failAfter?: number };

const L = (doing: string, where: string, failAfter?: number): ToolLabel => ({
  doing,
  where,
  failAfter,
});
const FILE_READ = L("ファイルを読み取り中", "ファイルの読み取り");
const FILE_EDIT = L("ファイルを編集中", "ファイルの編集");
// 実在する道具名（src/agents/tools・tool-display-config.ts）。未知の名前は labelOf() の汎用ラベルになる。
export const DEFAULT_TOOL_LABELS: Record<string, ToolLabel> = {
  read: FILE_READ,
  memory_get: FILE_READ,
  write: L("ファイルを作成中", "ファイルの作成"),
  edit: FILE_EDIT,
  apply_patch: FILE_EDIT,
  pdf: L("PDFを読み取り中", "PDFの読み取り"),
  view_image: L("画像を確認中", "画像の確認"),
  image: L("画像を確認中", "画像の確認"),
  image_generate: L("画像を生成中", "画像の生成"),
  music_generate: L("音楽を生成中", "音楽の生成"),
  video_generate: L("動画を生成中", "動画の生成"),
  tts: L("音声を作成中", "音声の作成"),
  web_search: L("Web検索中", "Web検索"),
  web_fetch: L("Webページを取得中", "Webページの取得"),
  browser: L("ブラウザで確認中", "ブラウザでの確認"),
  memory_search: L("記憶を検索中", "記憶の検索"),
  message: L("メッセージを送信中", "メッセージの送信"),
  cron: L("定期実行を設定中", "定期実行の設定"),
  // exec 系は grep の不一致などで日常的に非 0 終了する。2 回続いて初めて知らせる（failAfter）。コマンド本文は決して出さない。
  exec: L("処理を実行中", "処理の実行", 2),
  bash: L("処理を実行中", "処理の実行", 2),
  process: L("処理を実行中", "処理の実行", 2),
  code_execution: L("計算処理を実行中", "計算処理", 2),
  sessions_spawn: L("別の担当に作業を依頼中", "別の担当への依頼"),
  subagents: L("別の担当の状況を確認中", "別の担当の確認"),
  agents_wait: L("別の担当の作業を待機中", "別の担当の待機"),
};

/** パス・URL・コマンド・長いトークンを落とす（best-effort。主たる防御は args/title を読まないこと）。 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/`[^`]*`/g, "（省略）"],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "（URL）"],
  [/\bwww\.\S+/gi, "（URL）"],
  [/\b[A-Za-z]:[\\/]\S*/g, "（パス）"],
  [/\\\\[\w.$-]+\\\S*/g, "（パス）"],
  [/(^|[\s(（「"'=:])(?:~|\.{1,2})?(?:\/[^\s/（）()「」"']+)+\/?/g, "$1（パス）"],
  [/\b[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8}\b/g, "（パス）"],
  [/\b(?:Bearer|Basic)\s+\S+/gi, "（認証情報）"],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{8,}/g, "（認証情報）"],
  [/\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:：]\s*\S+/gi, "（認証情報）"],
  [/(^|\n)\s*[$#>]\s+\S[^\n]*/g, "$1（省略）"],
  [
    /\b(?:sudo|curl|wget|ssh|scp|rsync|chmod|chown|rm|mv|cp|cat|grep|sed|awk|find|xargs|docker|kubectl|git|npm|npx|pnpm|yarn|pip3?|python3?|node|bash|sh|zsh|powershell|cmd)\b(?=\s+(?:-{1,2}\w|[\w./~$"'-]*[/.$"'|<>&;=]))[^\n]*/gi,
    "（省略）",
  ],
  [/[A-Za-z0-9_+/=-]{24,}/g, "（省略）"],
];
export function redactForCustomer(text: string): string {
  return REDACTIONS.reduce((s, [re, to]) => s.replace(re, to), text)
    .replace(/\s+/g, " ")
    .trim();
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60
    ? `${s}秒`
    : s % 60 === 0
      ? `${s / 60}分`
      : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}

export type TextProgressReplyOptions = Pick<
  GetReplyOptions,
  | "suppressDefaultToolProgressMessages"
  | "onAgentRunStart"
  | "onAgentRunTerminalOutcome"
  | "onToolStart"
  | "onItemEvent"
  | "onCommandOutput"
  | "onPlanUpdate"
  | "onApprovalEvent"
  | "onCompactionStart"
  | "onCompactionEnd"
>;
type StageCallbacks = Omit<TextProgressReplyOptions, "suppressDefaultToolProgressMessages">;

/** いまの段階（道具・許可待ち・整理中・別の担当・考え中）。since = その段階が始まった時刻。 */
export type StageView = {
  /** core から何か信号が届いたか（実行開始を含む）。false の間は何も分かっていない。 */
  seen: boolean;
  kind: "approval" | "compaction" | "tool" | "subagent" | "thinking";
  doing: string;
  since: number;
  /** 例: 手順2/4「金額を集計する」（モデルの計画。redact 済み） */
  step?: string;
  idle: boolean;
};

export type StageTrackerOptions = {
  now: () => number;
  redact: (text: string) => string;
  /** 小文字化した道具名 -> ラベル。無ければ DEFAULT_TOOL_LABELS、それも無ければ汎用ラベル。 */
  labelFor?: (key: string) => ToolLabel | undefined;
  showPlanSteps?: boolean;
  nextAfterFailure: string;
  nextAfterFinalFailure: string;
  /** 客向けの失敗文が出る時に呼ぶ（連続失敗の間引きは適用済み）。final = 実行が失敗で終わった時の最終文。 */
  onNotice: (text: string, kind: "failure" | "final") => void;
  /** 状態が変わった時に呼ぶ（push 型はここでタイマーを組み直す）。 */
  onChange: () => void;
};

export type StageTracker = {
  /** reply options へ入れるコールバック（suppressDefaultToolProgressMessages は含まない）。 */
  callbacks: StageCallbacks;
  view(): StageView;
  noteToolFailure(e: { name?: string; toolCallId?: string }): void;
  noteSubagent(e: { phase: "started" | "ended"; outcome?: string }): void;
  finalFailureText(): string;
  /** 以後のイベントは全部無視する。 */
  stop(): void;
  readonly finished: boolean;
  readonly terminalFailureSent: boolean;
};

/** push 型（reporter）と pull 型（board）が共有する、1 回の実行の「段階」の追跡・失敗文の方針。送信もタイマーも持たない。 */
export function createStageTracker(o: StageTrackerOptions): StageTracker {
  const { now, redact } = o;
  let stopped = false,
    finished = false,
    seen = false,
    terminalFailureSent = false;
  let idleSince = now(),
    step: string | undefined,
    approvalSince: number | undefined,
    compactingSince: number | undefined;
  let subagents = 0,
    subSince = 0,
    lastFail: string | undefined;
  const active = new Map<string, { name: string; since: number }>(); // toolCallId -> 道具（最後に入れたものが「いま」）
  const consecutive = new Map<string, number>(); // 失敗箇所 -> 連続失敗回数
  const failedIds = new Set<string>();

  const labelOf = (name?: string): ToolLabel => {
    const key = (name ?? "").trim();
    const hit = o.labelFor?.(key.toLowerCase()) ?? DEFAULT_TOOL_LABELS[key.toLowerCase()];
    if (hit) return hit;
    if (!/^[\w.:-]{1,23}$/.test(key)) return L("別の作業を実行中", "別の作業");
    const safe = redact(key);
    return L(`「${safe}」を実行中`, `「${safe}」の実行`);
  };
  const view = (): StageView => {
    const last = [...active.values()].at(-1);
    const base: Pick<StageView, "kind" | "doing" | "since"> =
      approvalSince !== undefined
        ? { kind: "approval", doing: "操作の許可を待機中", since: approvalSince }
        : compactingSince !== undefined
          ? { kind: "compaction", doing: "会話の履歴を整理中", since: compactingSince }
          : last
            ? { kind: "tool", doing: labelOf(last.name).doing, since: last.since }
            : subagents
              ? { kind: "subagent", doing: "別の担当が作業中", since: subSince }
              : { kind: "thinking", doing: "考え中", since: idleSince };
    return { ...base, step, seen, idle: base.kind === "thinking" };
  };
  const finalFailureText = () =>
    `処理を完了できませんでした。${lastFail ? `失敗した箇所: ${lastFail}。` : view().idle ? "" : `止まった作業: ${view().doing}。`}${o.nextAfterFinalFailure}`;

  // failed = 道具の失敗 / notRun = 実行されなかった（許可不可・steering での skip: A は blocked、B は skipped を出す）/ denied = 許可が出なかった
  const fail = (
    name: string | undefined,
    id: string | undefined,
    mode: "failed" | "notRun" | "denied" = "failed",
  ) => {
    if (finished || stopped || (id && failedIds.has(id))) return;
    if (id) failedIds.add(id);
    const l = labelOf(name),
      n = (consecutive.get(l.where) ?? 0) + 1;
    consecutive.set(l.where, n);
    lastFail = l.where;
    const need = mode === "failed" ? (l.failAfter ?? 1) : 1;
    if (n < need || (n !== need && (n & (n - 1)) !== 0)) return; // 知らせるのは need 回目と 2 の冪乗回目だけ（連続失敗の洪水を防ぐ）
    const body =
      mode === "denied"
        ? `${l.where}は許可が得られず実行できませんでした。`
        : mode === "notRun"
          ? `${l.where}は行われませんでした。`
          : n >= 2
            ? `${l.where}で失敗が続いています（${n}回目）。`
            : `${l.where}で失敗しました。`;
    o.onNotice(`${step ? `${step}の途中、` : ""}${body}${o.nextAfterFailure}`, "failure");
    o.onChange();
  };
  const toolStarted = (id: string | undefined, name: string | undefined) => {
    approvalSince = undefined;
    const k = id ?? name ?? "?";
    active.set(k, { name: name ?? "", since: active.get(k)?.since ?? now() });
    o.onChange();
  };
  const left = () => {
    idleSince = now();
    o.onChange();
  }; // 何かが終わった。段階が「考え中」になるならその始まりはいま
  // コールバックは core を止めない（例外は握りつぶす）。stop 後は何もしない。最初の信号で seen にする。
  const ev =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      if (stopped) return;
      try {
        if (!seen) {
          seen = true;
          idleSince = now();
        }
        fn(...a);
      } catch {
        /* 表示は best-effort */
      }
    };

  const callbacks: StageCallbacks = {
    onAgentRunStart: ev(() => {
      if (finished) {
        // 同じ replyOptions で次の実行が始まった（queue に積まれたメッセージ。積んだ dispatch の options で走る）
        finished = false;
        terminalFailureSent = false;
        lastFail = undefined;
        step = undefined;
        subagents = 0;
        approvalSince = compactingSince = undefined;
        active.clear();
        consecutive.clear();
        failedIds.clear();
        idleSince = now();
      }
      o.onChange();
    }),
    onToolStart: ev((p: Arg<"onToolStart">) => {
      if (p?.phase === "start" || p?.phase === "update")
        toolStarted(p.toolCallId ?? p.itemId, p.name);
    }),
    onItemEvent: ev((p: Arg<"onItemEvent">) => {
      // preamble（モデルの前置き）・status（Fast 等）・hidden（progress_card/poll 等の内部）は客に見せない
      if (
        !p ||
        p.hideFromChannelProgress ||
        p.suppressChannelProgress ||
        !["tool", "command", "patch"].includes(p.kind ?? "")
      )
        return;
      const id = p.toolCallId ?? p.itemId;
      if (p.phase !== "end") return p.status === "running" ? toolStarted(id, p.name) : undefined;
      if (id) active.delete(id);
      if (p.status === "failed") return (fail(p.name, id), left());
      if (p.status === "blocked") {
        // approvalId あり = 許可待ち（失敗ではない）。なし = 許可不可 / skip（実行されなかった）
        if (p.approvalId || p.approvalSlug) {
          approvalSince = now();
          return o.onChange();
        }
        return (fail(p.name, id, "notRun"), left());
      }
      if (p.status === "completed") consecutive.delete(labelOf(p.name).where);
      left();
    }),
    onCommandOutput: ev((p: Arg<"onCommandOutput">) => {
      if (p?.phase !== "end") return; // output / cwd は読まない。終了状態と exit code だけ
      if (p.status === "failed" || (typeof p.exitCode === "number" && p.exitCode !== 0))
        fail(p.name ?? "exec", p.toolCallId);
    }),
    onPlanUpdate: ev((p: Arg<"onPlanUpdate">) => {
      const steps = p?.steps ?? [];
      const run = steps.findIndex((s) => s.status === "in_progress");
      const i = run >= 0 ? run : steps.findIndex((s) => s.status === "pending");
      const text =
        i >= 0 && o.showPlanSteps !== false ? redact(steps[i]?.step ?? "").slice(0, 40) : "";
      step = i >= 0 ? `手順${i + 1}/${steps.length}${text ? `「${text}」` : ""}` : undefined;
      o.onChange();
    }),
    onApprovalEvent: ev((p: Arg<"onApprovalEvent">) => {
      if (p?.status === "pending") {
        approvalSince = now();
        return o.onChange();
      }
      approvalSince = undefined;
      if (p?.status === "denied" || p?.status === "unavailable" || p?.status === "failed")
        fail(
          active.get(p.toolCallId ?? "")?.name ?? (p.kind === "exec" ? "exec" : undefined),
          p.toolCallId,
          "denied",
        );
      left();
    }),
    onCompactionStart: ev(() => {
      compactingSince = now();
      o.onChange();
    }),
    onCompactionEnd: ev(() => {
      compactingSince = undefined;
      left();
    }),
    // 'completed' の後に最終 payload 組み立てで 'failed' が来ることがある（agent-runner-result-payloads.ts）。latch しない。
    onAgentRunTerminalOutcome: ev((outcome: "completed" | "failed") => {
      if (outcome === "failed" && !terminalFailureSent) {
        terminalFailureSent = true;
        o.onNotice(finalFailureText(), "final");
      }
      finished = true;
      o.onChange();
    }),
  };

  return {
    callbacks,
    view,
    finalFailureText,
    noteToolFailure: ev((e: { name?: string; toolCallId?: string }) => fail(e.name, e.toolCallId)),
    noteSubagent: ev((e: { phase: "started" | "ended"; outcome?: string }) => {
      if (e.phase === "started") {
        if (!subagents) subSince = now();
        subagents += 1;
      } else {
        subagents = Math.max(0, subagents - 1);
        if (e.outcome && e.outcome !== "ok") fail("sessions_spawn", undefined);
        idleSince = now();
      }
      o.onChange();
    }),
    stop() {
      stopped = true;
      active.clear();
    },
    get finished() {
      return finished;
    },
    get terminalFailureSent() {
      return terminalFailureSent;
    },
  };
}

export type TextProgressOptions = {
  /** 新しいメッセージを 1 通送る（編集はしない）。reject / throw は握りつぶす。 */
  send: (text: string) => Promise<void>;
  now?: () => number;
  /** タイマー登録。取消関数を返す（既定: setTimeout/clearTimeout）。 */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** 最初の状況通知までの待ち（既定 1500。短い処理では何も出さない）。 */
  firstDelayMs?: number;
  /** 無言がこれだけ続いたら「まだ処理中」を出す（既定 25000）。 */
  tickMs?: number;
  /** 通知どうしの最小間隔。間隔内の変化は最新の 1 件にまとめる（既定 5000。失敗通知は対象外）。 */
  minGapMs?: number;
  /** 取り消し忘れ対策。この時間を過ぎたら自動で stop（既定 30 分）。 */
  maxTotalMs?: number;
  labels?: Record<string, ToolLabel>;
  redact?: (text: string) => string;
  /** false なら計画の文面は出さず「手順 2/4」だけにする（既定 true・redact 済み・40 字まで）。 */
  showPlanSteps?: boolean;
  nextAfterFailure?: string;
  nextAfterFinalFailure?: string;
};

export type TextProgressReporter = {
  /** dispatch の replyOptions へそのまま展開する。 */
  replyOptions: TextProgressReplyOptions;
  start(): void;
  /** 以後は一切送らない（飛行中の 1 通は取り消せない）。dispatch の finally で必ず呼ぶ。 */
  stop(): void;
  /** core の hook（after_tool_call 等）から呼ぶ用。エラー本文は渡さない。 */
  noteToolFailure(e: { name?: string; toolCallId?: string }): void;
  /** subagent_progress hook から呼ぶ用。 */
  noteSubagent(e: { phase: "started" | "ended"; outcome?: string }): void;
  /** 実行が失敗で終わった時の最終文（core の英語定型文 final の置換用）。 */
  finalFailureText(): string;
  readonly terminalFailureSent: boolean;
};

/** push 型: 自分で送信とタイマーを持つ。plugin 側にタイマーが無い時はこちら。 */
export function createTextProgressReporter(o: TextProgressOptions): TextProgressReporter {
  const now = o.now ?? Date.now;
  const setTimer =
    o.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const { firstDelayMs = 1500, tickMs = 25_000, minGapMs = 5_000, maxTotalMs = 30 * 60_000 } = o;
  const redact = o.redact ?? redactForCustomer;

  let started = false,
    stopped = false,
    inFlight = false,
    sent = 0;
  let startedAt = 0,
    lastSentAt = -Infinity,
    lastPhase = "",
    cancel: (() => void) | undefined;
  const urgent: string[] = [];
  const tracker: StageTracker = createStageTracker({
    now,
    redact,
    labelFor: (k) => o.labels?.[k],
    showPlanSteps: o.showPlanSteps,
    nextAfterFailure: o.nextAfterFailure ?? "別の方法を試します。",
    nextAfterFinalFailure:
      o.nextAfterFinalFailure ??
      "依頼の内容やファイル・URLをご確認のうえ、もう一度お試しください。",
    onNotice: (text) => {
      urgent.push(text);
    },
    onChange: () => {
      if (!started) start();
      else rearm();
    },
  });

  const phaseMsg = () => {
    const v = tracker.view();
    return `${v.doing}です${v.step ? `（${v.step}）` : ""}。`;
  };
  const tickMsg = () => {
    const v = tracker.view();
    return `まだ処理中です（${[v.doing, v.step, `経過${formatElapsed(now() - startedAt)}`].filter(Boolean).join("・")}）`;
  };
  // 状況通知を出すのは「直近に送った状況文と違う」時だけ。2 通目以降は「考え中」へ戻っただけでは出さない（tick が担う）。
  const wantsPhase = () => phaseMsg() !== lastPhase && !(tracker.view().idle && sent > 0);
  const phaseDue = () => Math.max(startedAt + firstDelayMs, lastSentAt + minGapMs);

  const rearm = () => {
    cancel?.();
    cancel = undefined;
    if (!started || stopped || inFlight) return;
    if (now() - startedAt >= maxTotalMs) return stop();
    if (urgent.length) return fire(); // 失敗通知は gate / 間隔の対象外（送信中なら上で待ち、終われば deliver が再開する）
    let due = tracker.finished ? Infinity : Math.max(lastSentAt, startedAt) + tickMs;
    if (!tracker.finished && wantsPhase()) due = Math.min(due, phaseDue());
    if (due !== Infinity) cancel = setTimer(fire, Math.max(0, due - now()));
  };
  const fire = () => {
    cancel = undefined;
    if (stopped || inFlight) return; // 送信が終われば deliver の finally が rearm する
    const t = now();
    if (t - startedAt >= maxTotalMs) return stop();
    const u = urgent.shift();
    if (u !== undefined) return void deliver(u);
    if (!tracker.finished && wantsPhase() && t >= phaseDue())
      return void deliver((lastPhase = phaseMsg()));
    if (!tracker.finished && t >= Math.max(lastSentAt, startedAt) + tickMs)
      return void deliver(tickMsg());
    rearm();
  };
  const deliver = async (text: string) => {
    if (stopped || inFlight) return;
    inFlight = true;
    lastSentAt = now();
    sent += 1;
    try {
      await o.send(redact(text));
    } catch {
      /* 表示は best-effort。redact が失敗した文も送らない */
    } finally {
      inFlight = false;
      rearm();
    }
  };

  function start() {
    if (started || stopped) return;
    started = true;
    startedAt = now();
    rearm();
  }
  function stop() {
    stopped = true;
    tracker.stop();
    cancel?.();
    cancel = undefined;
    urgent.length = 0;
  }

  return {
    // verbose が off の既定では onToolStart / onItemEvent 等は dispatch に捨てられる（dispatch-from-config.prepare-execution.ts の
    // shouldForwardProgressCallback）。この印を立てると届き、既定の英語「🛠️ Exec: …」の tool 文は出ない。
    replyOptions: { suppressDefaultToolProgressMessages: true, ...tracker.callbacks },
    start,
    stop,
    noteToolFailure: tracker.noteToolFailure,
    noteSubagent: tracker.noteSubagent,
    finalFailureText: tracker.finalFailureText,
    get terminalFailureSent() {
      return tracker.terminalFailureSent;
    },
  };
}
