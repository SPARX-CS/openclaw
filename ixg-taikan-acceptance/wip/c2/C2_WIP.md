# C2（Issue #5）公式LINE の着信が捨てられる件 — 途中で引き上げた状態

**試験は 1 件も実行していない。** ここにあるのは、コードを読んだだけの結論（静的）と、試験用の道具の下書き（未実行・型検査もしていない）。
クレジットの都合で、新しい試験・patch は始めずに引き上げた（ixg の指示）。「通った」とは言えない。

## コードを読んで分かったこと（A = 9.6、B = 9.7。行番号は A / B。**実行で確かめていない**）

1. **事故の原因は、本当の draining ではなかった。** `enqueueCommandInLane`（`src/process/command-queue.ts` A:554 / B:541）は、受付が閉じていると `GatewayDrainingError` で拒否する。受付の判定（`src/process/gateway-work-admission.ts` A:223-237 / B:212-223）は、再起動の drain などのほかに、**AsyncLocalStorage の root が `released` になっている**場合も「閉じている」とする。gateway は plugin の HTTP route を `runWithGatewayHttpWorkAdmission`（`src/gateway/server/plugins-http.ts` A:330 / B:362、`http-work-admission.ts`）で包み、handler が戻ると root を release する。7.1 の plugin は 200 を返した**後**に `Promise.resolve().then(handleWebhook)` を走らせるので、その store を引き継いだまま release 後に enqueue して拒否された。
2. **直し（本番の 3 行）の意味**: `runDetachedWebhookWork`（`src/plugin-sdk/webhook-request-guards.ts` A:325 / B:315）は、request の root が生きている間に独立した root（`webhook:detached`）を確保し、後ろの処理をその下で走らせる。core 側の説明は同 file の docstring と `docs/plugins/sdk-overview/infrastructure.md:301`、既存の再現試験は `webhook-request-guards.test.ts` A:346 / B:344。
3. **素の 9.7 の同梱 LINE には、7.1 の型は無い（読んだ範囲）。** `extensions/line/src/webhook-node.ts:102-162` は、署名・body 上限・JSON を確かめ、`await bot.handleWebhook`（= `webhook-spool.ts:378` の `accept`）で **SQLite（`<stateDir>/state/openclaw.sqlite` の `channel_ingress_events`）へ永続化してから** 200 を返す（`x-openclaw-delivery-accepted: durable`）。後ろの処理（pump）は `runDetachedWebhookWork` の下（`webhook-spool.ts:337`）。DB 書き込みが失敗すれば 500。
4. **restart・draining 中の着信（読んだ範囲）**: 要求の前に draining なら gateway の層が 503＋`Retry-After: 1`（`http-work-admission.ts:36`）。応答後に draining になっても行は残り、pump が止まり、`GatewayDrainingError` なら `releaseClaim(recordAttempt:false)`（`ingress-drain.ts` A:241 / B:244）で後継が拾い直す。配送は at-least-once（`docs/channels/line.md:49-56`）、重複は event id（`message:<id>`／`event:<webhookEventId>`）の主キーで落とす。
5. **配送できない時、客には何も出ない**（ログのみ）。8 回（1 秒〜上限 3 分の backoff）で dead-letter、恒久的な失敗は即 dead-letter。復旧は `openclaw channels dead-letters list|resubmit --channel line --account default`。恒久的な media 失敗は本文が `[line attachment unavailable]` になる（`bot-message-context.ts:553`）だけで、客へ直接の通知は無い。
6. **media**: 画像・動画・音声・file（PDF は file）だけを落とす（`bot-handlers.ts:74`）。上限は `channels.line.mediaMaxMb`（既定 10）なので 2.5 MB の PDF は通る見込み。`download.ts` は A・B 同じ。
7. 設定キー: `channels.line.{channelAccessToken, channelSecret, tokenFile, secretFile, webhookPath, mediaMaxMb, historyLimit}`。spool の場所・保持・再試行・drain の時間を決める設定キーは無い（`OPENCLAW_STATE_DIR` と、コードの定数）。

## 手に入れた材料

- 7月の LINE plugin 実物: 公開の npm から取れた（`npm pack @openclaw/line@2026.7.1`。dist の `monitor-0eXlx_Pe.js` の 1189・1465 行に `Promise.resolve().then(...handleWebhook(body))` がある。材料の diff（`line-plugin-7.1-detach.diff`）と一致）。対照の試験に使える。
- 試験の道具の下書き `c2-line-flow.support.ts`（19 KB・**未実行**）: 本物の gateway の plugin route（`createGatewayPluginRequestHandler`）→ 同梱 LINE の `monitorLineProvider` → durable spool（一時の state dir の SQLite）→ メッセージの組み立て（media は fetch を偽にして）→ `core.channel.inbound.run`（唯一の偽。command lane へ enqueue してから採用）。dummy の secret・token。`c2-probe.test.ts` はその最初の動作確認の下書き（これも未実行）。使うには、2 つを `tests/` に戻して `./run.sh <木> A_c2 c2`。

## 試していない物（次に誰が何を見るか）

| #   | 見ること                                                                                                                                                                                                                                                           | 誰が・どこで                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | **普段の着信**（文・画像・PDF 約 2.5 MB）が、同梱 LINE で断られず agent の turn まで進むか                                                                                                                                                                         | 下書きの道具で試験を書く（B と、比較に A）                                                                  |
| 2   | **9.7 の同梱 LINE が、gateway の HTTP 受付の範囲内で、応答後の処理を拒否されないか**（上の 3 の実行での確認）                                                                                                                                                      | 同上。`runWithGatewayHttpWorkAdmission` の中で回す                                                          |
| 3   | **対照**: 7.1 の plugin を 9.6 と 9.7 の core の両方に載せた時の再現と、3 行の直しで通ること。7.1 の plugin を 9.7 でも使い続けるなら、受付の仕組みは 9.7 でも同じなので直しが要る見込み（コードの判断・未実行）                                                   | npm の dist ＋ 材料の diff                                                                                  |
| 4   | **restart・draining**: 503＋Retry-After／応答後の draining → 再起動後にちょうど 1 回だけ配送／同じ event の重複／DB 失敗は 500（上の 4）                                                                                                                           | 一時の state dir の spool を使い、`markGatewayRestartDraining` → `resetGatewayWorkAdmission` → 新しい spool |
| 5   | **配送不能（dead-letter）の時に、客に何も出ない**ことの記録と、短い通知を出す案（返信トークンか push で 1 通）                                                                                                                                                     | 試験（記録）＋最小の patch の提案。今は未着手                                                               |
| 6   | 再試行・backoff の定数の確認（8 回・1 秒・3 分・claim 30 分・poll 500 ms・並行 8）                                                                                                                                                                                 | コードの定数を読む試験                                                                                      |
| 7   | **実機でしか分からない物**: LINE console の webhook 再送の設定（503 の時に LINE が再送するか）／7.1 の返信トークンの謝罪文が本番で客に届いたか／agent が PDF をどう読むか（media 取得の後）／7.1 から同梱への切り替えで、既存の設定・replay の記録が引き継がれるか | ixg・実機                                                                                                   |

patch は作っていない。同梱 LINE に 7.1 の型が見つかっていないので、現時点で必要な patch は無い見込み（未実行）。7.1 plugin を使い続ける場合だけ、本番の 3 行の直し（同梱の `line-plugin-7.1-detach.diff`）が要る。
