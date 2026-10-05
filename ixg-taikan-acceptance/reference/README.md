# テキスト専用チャネル（LINE WORKS 自作 plugin）の「処理中」表示 — 参照実装と組み込みの手引き

編集できない・文字だけのチャネルで、客に「いま何を処理中か」「まだ動いているか」「どこで失敗したか」を見せる。
**core は変えない**。core が既に出す信号（reply options のコールバック）を使う。2 つの形がある。

- **push 型** `text-channel-progress.ts`（自分で送信とタイマーを持つ）: §1〜§6。依存は型のみ。
- **pull 型** `text-channel-progress-board.ts`（送信もタイマーも持たない掲示板）: plugin が**自前のタイマー**で push している時用（LINE WORKS の intervalAck）。§7 と
  `lineworks-monitor.progress-example.diff`。段階の追跡・ラベル・伏せ字・失敗文の方針は両方で共有（`createStageTracker`）。
  試験は `tests/f7-*.test.ts`（A/B とも 114 件・全部通る）。

## 1. 組み込み（plugin 側）

`reference/text-channel-progress.ts` を plugin へコピーし、1 ターン（1 回の dispatch）に 1 つ作る。

```ts
import { createTextProgressReporter } from "./text-channel-progress.js";

const progress = createTextProgressReporter({
  send: (text) => lineWorksQueue.sendText(roomId, text),
});
progress.start(); // 受信直後。1.5 秒より短く終わる処理では何も出ない
try {
  await core.channel.inbound.dispatch({
    // 同梱の IRC plugin（extensions/irc/src/inbound.ts）と同じ呼び方
    cfg,
    channel: "lineworks",
    accountId,
    route: { agentId, sessionKey },
    ctxPayload,
    delivery: {
      preparePayload: (payload, info) =>
        // core の最終文が失敗（英語「⚠️ PDF failed」等）なら日本語へ差し替える
        info.kind === "final" && payload.isError
          ? progress.terminalFailureSent
            ? null
            : { ...payload, text: progress.finalFailureText() }
          : payload,
      deliver: async (payload) => {
        if (payload.text) await lineWorksQueue.sendText(roomId, payload.text);
      },
      onError: (err, info) => log(`lineworks ${info.kind} failed: ${String(err)}`),
    },
    replyPipeline: {},
    replyOptions: { ...progress.replyOptions /* 既存の onAgentRunStart 等がある場合は下の注意 */ },
    record: {},
  });
} finally {
  progress.stop(); // 必ず呼ぶ。以後は何も送らない
}
```

- 型の import 先: `import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime"`（公開 SDK）。
- `progress.replyOptions` が持つもの: `suppressDefaultToolProgressMessages: true`、`onAgentRunStart`、`onAgentRunTerminalOutcome`、
  `onToolStart`、`onItemEvent`、`onCommandOutput`、`onPlanUpdate`、`onApprovalEvent`、`onCompactionStart/End`。
  **plugin が同名のコールバックを既に持つなら、スプレッドで上書きされるので自分で連結する**（両方呼ぶ）。
- subagent の開始/終了は hook: `api.on("subagent_progress", (e) => progress.noteSubagent(e))`（`phase: started|ended`・`outcome`）。
  hook の `after_tool_call` からは `progress.noteToolFailure({ name, toolCallId })`（`error` 本文は渡さない）。通常は item イベントで足りる。
- `lineWorksQueue` は plugin 既存の「ルームごとの送信キュー」を通す（進捗と最終返信の順序が逆転しないように）。

## 2. 何が出るか（既定値）

| 場面                          | 文（例）                                                                                        | 方針                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 開始 1.5 秒後もまだ処理中     | `PDFを読み取り中です。` / 道具がまだ無ければ `考え中です。`                                     | 速い処理では出さない                                                 |
| 作業が変わった                | `Web検索中です。`（新しいメッセージ）                                                           | 同じ文は出さない。直前の送信から 5 秒未満なら最新の 1 件にまとめる   |
| 無言が 25 秒続いた            | `まだ処理中です（PDFを読み取り中・経過1分16秒）`                                                | 経過は `start()` からの実時間。送信のたびに 25 秒を数え直す          |
| モデルの計画（progress_card） | `PDFを読み取り中です（手順2/4「金額を集計する」）。`                                            | 文面は伏せ字処理後 40 字まで。`showPlanSteps:false` で番号だけ       |
| 道具が失敗                    | `PDFの読み取りで失敗しました。別の方法を試します。`                                             | 即時（待ちなし）。手順があれば `手順2/4「…」の途中、` を前置         |
| 同じ所で失敗が続く            | `…で失敗が続いています（4回目）。…`                                                             | 1・2・4・8 回目だけ（洪水防止）                                      |
| 実行されなかった              | `処理の実行は行われませんでした。…` / 許可が出ない時 `…は許可が得られず実行できませんでした。…` | 許可待ち（approvalId あり）は失敗ではなく `操作の許可を待機中です。` |
| 実行が失敗で終了              | `処理を完了できませんでした。失敗した箇所: PDFの読み取り。…`                                    | `onAgentRunTerminalOutcome("failed")` で 1 回                        |

- exec 系（`exec`/`bash`/`process`）の非 0 終了は grep の不一致などで日常的に起きる。**2 回続いて初めて**知らせる（`labels` の `failAfter`）。
- 完了（`"completed"`）を受けたら tick は止まる。ただし core は `completed` の後に最終文の組み立てで `failed` を出すことがあるので、止めても失敗通知は受ける。
- 調整: `firstDelayMs(1500)` `tickMs(25000)` `minGapMs(5000)` `maxTotalMs(30分・stop 忘れの保険)` `labels` `nextAfterFailure` `nextAfterFinalFailure` `redact`。
- 道具名の表示は `DEFAULT_TOOL_LABELS`（read/write/edit/pdf/web_search/web_fetch/image_generate/exec/sessions_spawn …）。
  未知の名前は `「{道具名}」を実行中`（英数 23 字まで）、変な名前は `別の作業を実行中`。plugin 独自の道具は `labels` に足す。

## 3. 客に出してはいけないもの（伏せ字の決まり）

- core が `onToolStart.args` に渡すのは **鍵だけ伏せた**もの。`onItemEvent.title/meta`・`onApprovalEvent.command`・`onCommandOutput.output/cwd` には
  パス・URL・コマンド本文が入る（F7.9b・F7.11 で実測）。参照実装はこれらを**一切読まない**。使うのは道具名・状態・exit code・手順番号だけ。
- 例外は計画の文面（モデルが書く）と未知の道具名。これと**全送信文**に `redactForCustomer` を掛ける（URL・絶対/相対パス・Windows パス・バッククォート・
  `$ `行・代表的なコマンド・Bearer/鍵形式・24 字以上の長い文字列を落とす）。best-effort なので厳しくしたい時は `redact` で連結する。
  `redact` が例外を投げた文は**送らない**（安全側）。
- core の `error` は event handler が落とす（B・A とも）。`hideFromChannelProgress`/`suppressChannelProgress` の item、`kind: preamble|status` は無視する。

## 4. 客向けの既定（守る設定）

- **`suppressDefaultToolProgressMessages: true` が要る**（参照実装は立てる）。verbose が off の既定では、dispatch は `onToolStart`/`onItemEvent`/
  `onCommandOutput`/`onPlanUpdate`/`onApprovalEvent`/`onCompactionStart` を plugin へ渡さない（F7.12b で実測）。立てると届き、既定の英語 `🛠️ …` の tool 文は出ない（F7.12）。
- **verbose は `on`/`full` にしない**。`🛠️ PDF: /home/…` のような英語文と生のパスが客へ届く（F7.13）。`full` は失敗の詳細まで出る。
- core の `channels.<ch>.streaming.mode: "progress"` と `streaming.progress.*` は**編集できる下書き**用。LINE WORKS では使わない。
  併用するなら `toolProgress: false`（既定）・`commandText: "status"`（`"raw"` はコマンド本文が出る）。`toolProgressDetail`（`raw`）も使わない。
- 時間切れ・再試行・モデルは**変えない**（表示だけ）。

## 5. core が出せないもの（限界）

- モデルが考えているだけの区間は信号が無い（tool 開始・終了だけ）。`考え中（経過◯秒）` の tick で「生きている」ことだけを示す。
  `onReasoningProgress` は claude-cli 経路にしか無く、`onNarrationUpdate` は utility model が要る（英語になり得る）ため使わない。
- 1 つの道具の**途中経過**（長い exec の途中）は無い。開始と終了だけ。
- 失敗の**理由**（error 本文）は handler が落とすので出せない。出せるのは「どの道具で」「どの手順の途中で」。
- 失敗の時点では、実行が続くか終わるか分からない。`別の方法を試します` と言った後に終わる場合があるので、最終文（`finalFailureText()`）で補う（F7.9c）。
- core の最終文の失敗は英語（`⚠️ PDF failed` / `Something went wrong…`）で、パスも理由も次の行動も無い。`preparePayload` で差し替える。

## 6. 試験で確かめたこと / 未確認

確認済み（A=9.6+patch・B=9.7 とも全件通る）: 偽の LLM → 本物の session loop・subscribe の tool handler → 本物の `createAgentRunEventHandler` →
`runReplyAgent`（F7.8〜F7.10・F7.15）、本物の `dispatchReplyFromConfig`（F7.12/13）、本物の `dispatchAssembledChannelTurn`（F7.19）、reporter・board 単体（F7.1〜F7.7・F7.17/18・変異試験で感度を確認）。
A と B で、試したシナリオの信号は同じ。（コード読みの差: B は `skipped` 状態と `finalizeToolActivity` の隠し item が増える。steering で飛ばされた道具は A が `blocked`＝「行われませんでした」、B が `skipped`＝無視。未実行。）

**未確認**: LINE WORKS 実機（送信間隔の制限・429・文字数上限・送信順）／`delivery.preparePayload` での最終文の差し替え（型だけ確認）／
積まれたメッセージ（queue 実行）の間の表示（§7）／claude-cli 経路の信号（embedded 経路のみ実測）／hook と turn の対応付け（`subagent_progress` の `requester`）／
実モデルが `progress_card` を使う頻度／英語の計画文面の扱い（伏せ字のみで翻訳はしない）／plugin 本体への実適用（差分は plugin のコピーに当てて構文・型を確認しただけ）。

## 7. 自作 plugin（LINE WORKS）への入れ方 — 自前の「処理中」タイマーから読む（pull 型）

**前提**（`plugin_ref/lineworks-monitor.ts` を読んだ）: plugin は進捗を core 経由で出していない。intervalAck（本番: 初回 30 秒・以降 60 秒・direct のみ）が
固定文 `処理中...`＋`${ELAPSED}` を push する。key は `accountId + "\0" + to`（会話）。dispatch が何本あってもタイマーは 1 本（`activeDispatches`）。
`core.channel.inbound.dispatchReply({...})` には今 `replyOptions` を渡していない。**plugin は変えず**、差分の例だけを示す。

**入れ方**（`lineworks-monitor.progress-example.diff`・6 か所・+11/−4・plugin のコピーに `patch -p1`/`git apply -p1` で当たり、構文 OK・A/B の型で `replyOptions` が通ることを確認）:

```ts
const progressBoard = createProgressBoard();                 // intervalAckStates の隣（同じ寿命。タイマーが無いので clear 不要）
progress = progressBoard.attach(intervalAckKey);             // dispatch ごと。key はタイマーと同じ
await core.channel.inbound.dispatchReply({ ..., replyOptions: progress?.replyOptions });
const text = progressBoard.render(intervalAckKey!, startedAt) ?? renderLineworksIntervalAckText(...);   // pushIntervalAck 内
progress?.detach();                                          // finally
```

`reference/` の 2 ファイル（`text-channel-progress.ts`・`text-channel-progress-board.ts`）を plugin の src へ置く。firstDelayMs・intervalMs・scope・template は変えない。

**本体の読み口**（A・B とも読んで確認。本体の変更は不要）:

- `core.channel.inbound.dispatchReply` = `dispatchAssembledChannelTurn`（`plugins/runtime/runtime-channel.ts:133`・型 `types-channel.ts:166`）。
  `replyOptions?: ChannelTurnReplyOptions`（`channels/turn/types.ts` A:318 / B:329）＝ `GetReplyOptions` から `onBlockReply`/`onPreparedBlockReply` を除いた型。
- `channels/turn/lifecycle.ts`（`resolveAssembledReplyPipeline`・`dispatchChannelTurnWithDeliveryOwner`）は `onModelSelected` を足し、`onAgentRunStart` だけ包む（run id を記録して plugin の物へ連鎖）。
  残りは `dispatchReplyWithBufferedBlockDispatcher` → `dispatch.ts`（`{...replyOptions, …typing}`）→ `dispatchReplyFromConfig` へそのまま渡る。
  **渡る**: `onToolStart` `onItemEvent` `onCommandOutput` `onPlanUpdate` `onApprovalEvent` `onCompactionStart/End` `onAgentRunTerminalOutcome` `onAgentRunStart`（F7.19 で実行・A/B）。`replyOptions` 無しなら何も変わらない（F7.19b）。
- **verbose off でも届くのは `suppressDefaultToolProgressMessages: true` の時だけ**（`dispatch-from-config.prepare-execution.ts` の `shouldForwardProgressCallback`。A は `shouldAllowQuietChannelOwnedProgressCallbacks` 経由）。board の `replyOptions` が立てる（F7.12/12b）。
- core に「いまの段階を plugin が引く」口（API・session 状態）は無い。信号は callback の push だけ。だから board が最後の状態を持ち、plugin のタイマーが push の瞬間に引く。

**集約**: 1 dispatch = 1 attachment。同じ key に複数あれば**いちばん最近始まった段階**を出す（段階の経過＝その段階の開始から。`全体` は最初の dispatch から・段階が 10 秒以上後に始まった時だけ付く）。
最後の `detach()` で key を忘れる（F7.16b）。1 つの会話の複数 dispatch は plugin のタイマー 1 本のまま。

**render の出力**: `PDFを読み取り中です（経過45秒）`／`考え中です（経過30秒）`（道具が無い間）／`Web検索中です（経過40秒・全体1分30秒）`／
失敗して実行が続く間 `PDFの読み取りで失敗しました。別の方法を試しています。（全体の経過30秒）`（次の段階が始まると消える。exec の非 0 は 2 回続くまで出さない・連続失敗は 1/2/4/8 回目＝push 型と同じ方針）。F7.15・F7.17。

**null の時**: 実行がまだ始まっていない（lane/queue 待ち）・信号がまだ無い・実行が終わった（最終返信の直前）・redact 失敗。plugin は**今までの固定 template に戻す**（`?? renderLineworksIntervalAckText(...)` だけで足りる）。F7.16・F7.16f。

**direct と group**: board は `intervalAckSpec` がある時だけ attach する。本番は direct のみなので、group の dispatch には attach も `replyOptions` も無く core の動きは変わらない（F7.16d）。
group でも出したいなら scope を広げれば同じ経路で動く（group の mention 判定等は未確認）。

**積まれたメッセージ（queue）の注意**: core は queue された実行を、**積んだ側の `runReplyAgent` が作った runner＝その dispatch の `replyOptions`** で走らせる（`agent-runner-run.ts` B:305-316,410-416 / A:309-320,413-419）。
その dispatch は実行の前に終わる（F6.3 の知見）ので、plugin の `finally` の `detach()` の後に信号が来る。board は、同じ会話で生きている dispatch があればそれが引き取り、無ければ捨てる（その時はタイマーも無い）（F7.16c）。
queue 実行の間も出したいなら、plugin 側で「積んだ dispatch を queue 実行の終わりまで detach しない」等が要る（plugin の変更・未実測）。
