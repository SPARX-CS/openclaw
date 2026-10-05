# Issue #4: F2・F5 の直しの patch と、進捗表示の参照実装

#3（F1〜F6 の試験・README）の続き。土台は A（v2026.9.6＋base_series・`2e7c9fa1c`）と B（素の v2026.9.7・`c074824a2`）。
client の見方（オーナーの方針）: 客は内部の状況を知らない。処理できない時は「何が不足か／何が問題か／客に何を頼むか／できない理由」を結論を先に、「どこで失敗したか」を添えて、日本語で返す。**時間切れは短くしない**（遅い処理は失敗ではない）。

## 当て方（A・B どちらも `git apply`・clean な木に確認済み）

```bash
cd <A または B の木>
P=<この枝>/ixg-taikan-acceptance/patches
# F2（A・B 共通）
git apply $P/f2-suspended-completion-direct-delivery.patch
# F5b（連続失敗の一言）: core は共通・wiring と config baseline は版ごと（X = A または B）
git apply $P/f5b-failure-hint-core.patch $P/f5b-failure-hint-wiring-X.patch $P/f5b-config-baseline-X.patch
# F5a（401・許可外パスの文）: 独立。F5b なしでも・F5b と一緒でも当たる
git apply $P/f5a-media-failure-core.patch $P/f5a-media-failure-wiring-X.patch
```

優先は F2 → F5b → F5a（ixg の指示）。F5a は独立の patch なので、後回し・不要なら当てなくてよい。以前（#3）の `f4-*`・`f6-*` の patch は別件で、ここには含まない。

## 結果（前後・F1〜F7 の 232 件を A・B で回した）

「前」＝ patch なしの木に、**今の試験**（F2・F5 は書き直して件数が増えた）を回した結果。「後」＝上の patch を全部当てた木。**悪化（PASS→FAIL）は A・B とも 0 件**。

| 型                      | A 前    | A 後      | B 前    | B 後      |
| ----------------------- | ------- | --------- | ------- | --------- |
| F1 グループで黙る       | 10/11   | 10/11     | 10/11   | 10/11     |
| **F2 子の結果**         | 5/12    | **12/12** | 5/12    | **12/12** |
| F3 続けて 2 通          | 34/34   | 34/34     | 34/34   | 34/34     |
| F4 枠切れ               | 15/19   | 15/19     | 10/19   | 10/19     |
| **F5 道具の失敗**       | 13/27   | **27/27** | 13/27   | **27/27** |
| F6 処理中の 2 通目      | 9/15    | 9/15      | 10/15   | 10/15     |
| F7 進捗表示（参照実装） | 114/114 | 114/114   | 114/114 | 114/114   |
| 合計                    | 200/232 | 221/232   | 196/232 | 217/232   |

- PASS に変わった 21 件は A・B 同じ（F2: F2.2・F2.2b・F2.3 の 3 件・F2.5・F2.6 ／ F5: F5.2・F5.3・F5.4・F5.4b・F5.8b・F5.9 の 2 件・F5.9a/b/d/e・F5.12・F5.13・F5.14）。
- F5 の 27 件には「(unchanged by design)」の記録 4 件（F5.2b 認証 header は送らない／F5.6b ユーザー向けの警告は短いまま／F5.7 `tools.loopDetection` は既定 off のまま／F5.10 取得先の待ち 15 分は変えない）を含む。これらは「望ましい動作」でなく現状の記録なので PASS 扱い。
- F1・F3・F4・F6 の残りの不通は、この発注の外（F1 は設定 `surfaces.<ch>.silentReply.group="allow"`、F4・F6 は #3 の patch）。試験ごとの前後は `results/ISSUE4_BEFORE_AFTER.md`。

## patch ごとの中身・file:line・副作用

### F2（`f2-suspended-completion-direct-delivery.patch`・A・B 共通・新規 1 ファイル＋3 ファイルの変更）

- 依頼元を起こせず `suspended` になった結果を、**settle-wake が尽きた直後の最初の sweeper の tick**（試験では約 34 分後）で、①子の結果（文＋`MEDIA:` の添付）を依頼元の会話の送り先（`requesterOrigin`）へ**直接**送る（既存の `sendMessage` ＋ `mirror` で依頼元 session の記録にも残る）。②送れない時だけ、日本語の短い知らせ（「『{依頼}』の作業は終わりましたが、結果をこの会話へお届けできませんでした（{理由}）。{次の手}」。依頼名は label/task を 40 字までに切り、URL・パス・鍵らしい文字列を除く）。送り先が全く無い時は知らせを依頼元 session の記録にだけ入れる。③ discard の直前にも、まだ何も届いていなければ ① → ② をもう一度やる（バックストップ）。discard 自体は行う。
- 重複しない: 永続の印 `delivery.fallback` を**送る前に**書く（途中で落ちても二重送信にならず、「届いたか確認できません」扱い）。tick・再試行・再起動で結果も知らせも増えない。
- 場所: 新規 `src/agents/subagents/registry/subagent-registry-suspended-fallback.ts`（`deliverSuspendedFinalFallback` :259・`runAttempt` :297・知らせの文 :73-121）／`subagent-registry-suspended-delivery.ts`（判定と呼び出し・`ensureFinalOutcome`・約 :24-112, :169）／`subagent-registry-sweeper.ts`（呼び出し 2 か所・A: 約 :153, :316-330）／`subagent-registry-read.types.ts`（`fallback` の型 :82-116）／新規 unit 試験 28 件。
- 副作用: 新しい設定は無い。待ち時間・再試行の窓は変えない。1 回の送信は既存の `agents.defaults.subagents.announceTimeoutMs` で打ち切る。`delivery.fallback` は任意の永続項目（移行不要）。discard の warn ログに、印がある時だけ `fallback` が付く。知らせの文はコードに固定（日本語）。
- 限界: `message_tool_delivery_missing` で止まった行にも直接送る（エージェントが一部伝えていた場合、結果が 2 度見えうる）。private / ネストした子 / cron の依頼元・store が入れ替わった意図的な不配送は対象外。group は DM と同じ扱い。行は 7 日の discard まで `suspended` のままで、task の記録は「delivery failed」のまま。media が失敗した時の text だけの再送は無く、知らせになる。知らせの文面（特に「管理者」の語）はオーナーの確認前。実際の LINE WORKS・media upload は未実行（`sendMessage` を偽にして要求を記録）。

### F5b（連続失敗の一言・`f5b-failure-hint-core.patch`＋`-wiring-A/B`＋`-config-baseline-A/B`）

- 同じ道具・同じ失敗の**種類**が続けて失敗したら（引数が違っても数える）、N 回目（既定 3）から、道具の結果の後ろに「この方法では取れていません。別の方法に切り替えるか、利用者へ状況を伝えてください」＋客の視点の注意（何が足りないか・何が問題か・客に何を頼むか・できない理由を結論を先に。「もう一度送ってください」だけにしない）を 1 ブロック足す。**止めない**。種類: `http_401/403/404/429/4xx/5xx`・`path_not_allowed`・`not_found`・`not_pdf`・`timeout`・`other`。同じ道具の成功で連続がリセットされる（session ごと・新しい run でも）。承認の拒否・veto は数えない。
- 設定: `tools.failureHint.afterConsecutiveFailures`（整数 ≥0・既定 3・`0` で無効・全体のみ。schema・型・help・label あり）。`tools.loopDetection` の既定と、待ち時間は変えない。
- 場所（A / B）: 新規 `src/agents/tool-loop-failure-hint.ts`／`agent-tool-definition-adapter.ts`（成功のリセット 260 / 253・失敗の一言 296-301 / 281-286。ここが投げられたエラーが model の結果になる唯一の所）／`src/gateway/mcp-http.handlers.ts`（MCP の loopback。claude-cli のような CLI runtime はアダプターを通らないため。失敗 240・279 / 225・261、成功のリセット 248 / 233）／`zod-schema.agent-runtime.ts`（498・792 / 483・771）／`SessionState.toolFailureStreaks`（`logging/diagnostic-session-state.ts:19`）／types・help・labels。
- 副作用: 設定項目が増えるので config の表面の予算が上がる（core 2475→2477 など）＝ `docs/.generated/config-baseline.*` の再生成分を patch に含めた（版ごと）。throw せず返すだけの soft error は数えず・成功とも扱わない。Codex の harness・cron の script・HTTP の tools-invoke の経路にはまだ配線していない。per-agent の上書きは無い。web_fetch の失敗の分類は文言のパターン（`Web fetch failed (NNN)` のみ試験）。

### F5a（401・許可外パスの文・`f5a-media-failure-core.patch`＋`-wiring-A/B`・独立）

- pdf 道具・`view_image`・画像/動画/音楽の生成の参照の読み込みで、media の失敗を日本語の文に包み直して投げる（`src/media` の元の文は変えない）。**どこで失敗したか**（道具名＋段階: URL の取得／手元のファイル／種類の確認）を入れる。401/403: 認証付きの取得の道具で作業場へ落としてから、作業場の中のパスを渡す／道具が無ければ客にファイルを添付してもらうか共有設定を開けてもらう。許可外のパス: 道具が実際に許す root の一覧（`tools.fs.workspaceOnly=true` なら作業場だけに縮む）と、作業場へ移す／コピーする、または客に添付してもらう。404・5xx・他の 4xx・ネットワーク失敗・ファイルなし・PDF でない応答も包む。
- 文に入れない物: URL・パス・取得先の本文・認証情報（許可 root の一覧だけ入れる）。元の英語の理由は短く末尾に残す（既存の試験が見る）。元のエラーは operator 向けにログへ残る。
- 場所: 新規 `src/agents/tools/media-tool-failure.ts`（＋試験）／`pdf-tool.ts`・`image-tool.ts`・`media-tool-shared.ts`（A・B で別 patch）。副作用: `verbose=full` の時のユーザー向け「⚠️ PDF failed: …」が日本語の長い文になる。F5.3 は「許可外のパスがメッセージに出る」ことを主張しなくなった（オーナーの規則: パスを文に入れない）。
- 注: 本番側では、PDF の回り道に別の直し（取得の保存先を作業場の中へ＋bot の指示）を入れる予定（ixg）。F5a はその上に足す形で、必須ではない。

### F5c（`tools.loopDetection` の既定は変えない）

`tools.loopDetection` の既定は変えていない（未設定＝オフ）。同一の道具・同一の引数・同一の結果の繰り返しを止めたい場合は `tools.loopDetection.enabled=true` を設定する。11 回目で警告、21 回目の同一呼び出しからブロックされる（F5.8・F5.8b が確認）。引数（URL・パス）を変える回り道は `enabled=true` でもブロックされない。そちらは F5b の一言（`tools.failureHint.afterConsecutiveFailures`、既定 3、0 で無効、止めない）が受け持つ。

## 進捗表示（LINE WORKS の plugin から使う・`reference/`・core の変更なし）

- 自作の LINE WORKS plugin は「処理中...」を自前のタイマー（初回 30 秒・以降 60 秒・会話ごとに 1 本・固定の文）で push している。本体が出す進捗には乗らないので、**plugin のタイマーが push する時に、その会話の今の段階を読める板**を参照実装にした（`reference/text-channel-progress-board.ts`）。plugin は `core.channel.inbound.dispatchReply` の `replyOptions`（= `dispatchAssembledChannelTurn` が受け付ける）に、板の `attach(key).replyOptions` を渡し、タイマーの push で `board.render(key, now)` を読む（無ければ今の固定文）。
- 出る文の例: 「PDFを読み取り中です（経過30秒）」「考え中です（経過1分30秒）」（道具のイベントが無い間）「PDFの読み取りで失敗しました。別の方法を試しています。」。コマンド・パス・URL・鍵は出さない。複数の dispatch が 1 つのタイマーを共有する場合は、最後に始まった段階を出す。
- plugin への差し替え例: `reference/lineworks-monitor.progress-example.diff`（ixg が置いた plugin の写しへの 6 hunk・+11/−4。`patch --dry-run`・適用・TypeScript の構文検査で確認。plugin 本体は変えていない）。手引き: `reference/README.md`（§7 自作 plugin への入れ方）。push 方式の参照実装（`text-channel-progress.ts`）も残してある。
- 試験 114 件（A・B とも全部通る）: 本物の `runReplyAgent`・event handler を通して、`onToolStart`・`onItemEvent`・`onPlanUpdate`・`onApprovalEvent`・`onCompactionStart/End`・`onAgentRunTerminalOutcome` が plugin の `replyOptions` へ届くことと、plugin のタイマー構造（`activeDispatches`・key = account＋to）を再現した上での各 tick の文を確認。
- 必須の設定: `suppressDefaultToolProgressMessages: true`（無いと、verbose off では進捗の callback が来ない）。`verbose: full` は客には出さない（コマンド・パス・エラー本文が出る）。
- 未確認: 実際の plugin（差分を当てて build・実行はしていない）・LINE WORKS の rate limit・文字数・順序・queue された 2 通目の実行中の表示（その間 plugin にタイマーが無い）・claude-cli の経路・group の scope・`preparePayload` による最終文の置き換え（型のみ）。

## まとめて未確認・限界

- 本物の gateway・LINE WORKS の plugin・Claude CLI・本番は走らせていない（本物の core を seam で動かし、外側を偽にした）。
- patch の既存試験（repo 側）: F2 の担当は `src/agents/subagents/**`（A 127 ファイル 2632 件・B 130 ファイル 2420 件が通る）、F5 の担当は触った module・config schema・mcp-http（A 2022 件・B 1892 件が通る）。B の `mcp-http.session-controls` は 1 度だけ flaky で落ち、再実行で通った。A の assertion-safety チェックは、触っていない `ui/`・`extensions/` の 527 ファイルで元から落ちる。
- 通知文面（F2 の知らせ・F5 の一言・進捗の文）はオーナーの確認前の案。
