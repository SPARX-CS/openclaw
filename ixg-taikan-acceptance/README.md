# 体感の受入の試験（F1〜F6）— OpenClaw 2026.9.6＋base_series（A）と素の 2026.9.7（B）

ixg の発注（inspire-brain Issue #3・材料 `sparx-cloud-inputs/ixg/20261005_taikan_acceptance/`）。
「頼んだのに返事・成果物が届かない／長く待たされる」の型 F1〜F6 を、試験で再現して A／B に当てる。
各 `it` は**望ましい動作**を主張する。満たさない版では FAIL ＝「不通」（隠さない）。設定で直る物は「設定なし（FAIL しうる）」と「設定あり（PASS）」を対にしてある。
本番に繋がない・鍵や token を使わない・LINE WORKS の plugin と客の会話は使わない（channel は試験用の id）。

## 回し方

```bash
export PATH=<node 24>/bin:$PATH                    # engines: node >=24.16 <25
# A: upstream v2026.9.6 に base_series の 20 patch を当てた木 / B: upstream v2026.9.7 の木。それぞれ pnpm install --frozen-lockfile 済み
./ixg-taikan-acceptance/run.sh <A の木> A_all ""   # 全部（約 50 秒）。第3引数は試験名の前方一致（f1 〜 f6）。結果 out/A_all.json
./ixg-taikan-acceptance/run.sh <B の木> B_all ""
node ixg-taikan-acceptance/table.mjs out/A_all.json out/B_all.json   # 型ごと・試験ごとの A／B の表
```

`run.sh` は `tests/*.test.ts`（と `*.support.ts`）を `<木>/test/ixg-taikan/` へ写し、その木の `src` を import して vitest（`|unit-fast|`）で回す。src は変えない。
この枝（`cloud/ixg-taikan-acceptance`）は main の上に `ixg-taikan-acceptance/` を足しただけ（試験・patch・結果）。木に写して回す作りなので、A／B のどちらの木にも置ける。
今回の結果（`results/`）は、A = v2026.9.6 ＋ base_series 20 本（`2e7c9fa1c`）、B = v2026.9.7（`c074824a2`）。

## 構成

| 場所                                               | 中身                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tests/f1-group-no-reply.test.ts`                  | F1 グループの NO_REPLY（seed `groupjudge-no-reply.test.ts` を、mention 有/無/不明 × group/direct × 設定の有無に組み直した） |
| `tests/f2-subagent-result-delivery.test.ts`        | F2 子の結果の未達（本物の registry・announce・settle-wake・sweeper を fake timers で 8 日分）                               |
| `tests/f3-*.test.ts` `f3-*.support.ts`             | F3 続けて 2 通（dispatcher の FIFO lease と queue の各 mode）                                                               |
| `tests/f4-*.test.ts` `f4-*.support.ts`             | F4 枠切れ（本物の reply 層 `runReplyAgent` と `runWithModelFallback`・CLI のエラーは stream-json の `is_error` から）       |
| `tests/f5-tool-failure.test.ts` `.support.ts`      | F5 道具の失敗（本物の pdf tool を loopback の 401 サーバーと temp dir で。model には届かせない）                            |
| `tests/f6-second-message-while-processing.test.ts` | F6 処理中の 2 通目（TypingController・queue・dispatcher）                                                                   |
| `patches/`                                         | 直しの patch（検証済み。下記）                                                                                              |
| `results/`                                         | A／B の結果（`A.json` `B.json`・`TABLE.md` ＝ 試験ごとの表）                                                                |
| `run.sh` `summarize.mjs` `table.mjs`               | 回す・表にする道具                                                                                                          |

## 結果（103 件）

| 型                    | A pass/total | B pass/total |
| --------------------- | ------------ | ------------ |
| F1 グループで黙る     | 10/11        | 10/11        |
| F2 子の結果が戻らない | 5/9          | 5/9          |
| F3 続けて 2 通        | 34/34        | 34/34        |
| F4 枠切れ             | 15/19        | 10/19        |
| F5 道具の失敗         | 8/15         | 8/15         |
| F6 処理中の 2 通目    | 9/15         | 10/15        |
| 合計                  | 81/103       | 77/103       |

試験ごとの A／B は `results/TABLE.md`。

## 型ごと: 不通の所と直す所

### F1（A・B とも同じ）

- 不通: F1.1「設定なしの group で NO_REPLY → 無言」。固定の英語文（126 字）が出る。group の silent は既定で不許可（`src/shared/silent-reply-policy.ts:10-14`、A・B で同一ファイル）→ `replyExpectation=required` → 固定文（`agent-runner-failure-reply.ts` の `buildEmptyInteractiveReplyPayload`）。
- 設定で直る: `surfaces.<channel>.silentReply.group = "allow"`（F1.2〜F1.4 が通る）。direct は常に応答（F1.6）、cron・heartbeat は元から無言（F1.7）、明示 mention（`WasMentioned:true`）は応答のまま（F1.4・F1.5）。**この設定は 9.6 にもあり、9.7 で既定は変わっていない**。
- 注意: LINE WORKS の plugin は `WasMentioned` を渡さないので、`allow` にすると mention 付きの group でも無言になりうる（誤った NO_REPLY を検出できない）。plugin 側で mention を渡す直しが正道。

### F2（A・B とも同じ。9.7 で直らない）

- 通る: F2.1 画像の子の結果が、requester を起こせる時は会話へ届く。
- 不通: F2.2・F2.2b・F2.3・F2.5。requester を起こせない時、約 32〜34 分で `suspended` になり、settle-wake（3 回）が尽きた後は誰も触らず、7 日＋約 32 分で `discarded(expired)`。**その間、ユーザーへの直接の通知はゼロ**（残るのは warn ログと farewell hook だけ。停止時に積む requester 宛の systemEvent は、そのエージェントが起きなければ届かない）。
- 直す所: `src/agents/subagents/registry/subagent-registry-suspended-delivery.ts` の warn の直後（A・B で同一）に、`GatewayRecoveryRuntime.sendRecoveryNotice` で「結果を届けられなかった」を平文で送る（先例: `main-session-restart-recovery-failure.ts:45`・`channels/turn/pending-delivery-notice.ts:48`）。もっと早く出すなら `registry/subagent-registry-lifecycle-wake.ts` の `completeRequesterSettleWakeBatch`（A:98 / B:106）で、settle-wake が尽きて行が `suspended` のままなら同じ通知。A への一時的な差し込みで F2.2・F2.3・F2.5 が PASS に変わることを確認した（patch としては残していない）。
- 設定: 無い（保持 7 日・wake 回数・窓は全部コード内の定数。`agents.defaults.subagents.announceTimeoutMs` だけ）。

### F3（A・B とも全部通る）

- 3 秒差の 2 通は両方に返事が届く（FIFO lease・`dispatch.ts:315/356/402`）。7.1-2 の stale-foreground の再発なし（旧 fence を模した取消を足すと F3.1・F3.2 が落ちることを確認）。
- 注意（設定）: `messages.queue.mode = interrupt` は 1 通目を中断し返事を出さない（旧症状の再現）。既定の steer は 2 通目が実行中の turn に注入され、1 通目の final が両方に答える（答えるかは model 次第）。`followup`／`collect` は両方に返事。2 通を 1 回にまとめるのは `messages.inbound.debounceMs`（または `byChannel.<ch>`）＝4000 だが、plugin が core の debouncer を使う場合に限る。
- 記録: 同じ `MessageSid` の別メッセージは 20 分間「重複」として落ちる（plugin が id を使い回すと 2 通目が消える）。lease の待ちに時間切れが無い（固まった 1 通目は後続を止める。実際の上限は run の timeout）。

### F4（A 15/19・B 10/19）

- B だけ不通: F4.1・F4.1b・F4.7（2）。Claude CLI の `You've hit your session limit · resets 3pm` を、9.7 は分類できず（reason=`unknown`）、ユーザーには `⚠️ Agent run failed (model: …)`。A は sparx の patch 0006 で `rate_limit` に分類される。**新しい bot（素の 9.7）には 0006 の移植が要る**（`patches/f4-port-0006-session-limit-classification-to-9.7.patch`・B に当てて確認）。
- A・B とも不通: F4.2・F4.2b（通知が復帰時刻を言わず、`Please try again in a few minutes` と言う＝数時間ずれる）。直し: `src/agents/failover/user-copy.ts` の `renderRateLimitReplyCopy`（A:417 / B:411）で、session-limit も provider の文面（復帰時刻）を出す（`patches/f4-user-copy-show-reset-time.patch`）。B に 0006 の移植と合わせて当てると F4.1・F4.2・F4.7 が通る。
- A・B とも不通: F4.5・F4.8「枠が戻ったら止まった依頼を自分で続ける」。**同梱の再試行・再開の機能は無い**（9.7 の CHANGELOG にもゲートウェイ再起動後の再開だけ）。CLI runner は `rate_limit` を再試行しない（`cli-runner/cli-run-recovery.ts:25-53`）。`quotaSuspension` は次のユーザー発話で briefing を足すだけの受け身。案: 復帰時刻を `cli-runner/output-error.ts` で解析して `FailoverError` に持たせ、`agent-runner-error-handler.ts:186-296` で長い窓の `rate_limit` の時に止まった turn を保存し、復帰時刻＋余裕のタイマーで `enqueueFollowupRun` する。
- 設定で効く物: `agents.defaults.model.fallbacks` を**別の枠**（別 provider・API key）の候補にする（F4.8b が通る。claude-cli の候補には `agents.defaults.models["<ref>"].agentRuntime.id="claude-cli"` が要る）。同じ subscription の fallback は効かない（F4.8c）。9.7 の新機能ではない。

### F5（A・B とも同じ。9.7 で直らない）

- 通る: F5.1（401 は 1 回の試行で速く失敗し、`HTTP 401 Unauthorized` が分かる）・F5.3（許可外のパスは速く失敗しパスが分かる）・F5.5（`tools.fs.workspaceOnly=false` で既定の root 下 `<state>/canvas/` 等が開く／`true` で閉じる）・F5.6（model には `{status:"error", tool, error}` がすぐ返る）・F5.8（`tools.loopDetection.enabled=true` なら同一の失敗の繰り返しは 21 回目でブロック）。
- 不通: F5.2・F5.2b（401 の文面に開け方が無い／pdf は認証 header を送れない。`tools.web.fetch.headers` は web_fetch 専用）、F5.4（許可外パスの文面に設定・対処が無い。許可 root を足す設定は無い）、F5.6b（ユーザーへの既定の警告は `⚠️ PDF failed` だけ。理由は `verbose=full` の時のみ）、F5.7（`loopDetection` 未設定だと止まらない）、F5.9（**URL・パスを変えた 12 回の失敗は、`enabled=true` でも止まらない**＝本番の「回り道」を止められない）、F5.10（応答しない origin は 900 秒＝15 分の header 待ち）。
- 直す所（file:line は A / B）:
  1. 401 の案内: `src/agents/tools/pdf-tool.ts` の `loadWebMediaRaw` 呼び出し（A:548-557 / B:527-536）を包み、`MediaFetchError` の 401/403 に「認証が要る・pdf は認証情報を送らない」を足す（メッセージ生成 `src/media/fetch.ts` A:426-429 / B:422）。
  2. 認証付き取得: 同じ呼び出しの `requestInit`（A:556 / B:535）に header を渡す（`loadWebMediaRaw` は `requestInit.headers` を転送する。origin が `Bearer x` を受けることを確認）。キーは `tools.web.fetch.headers` を使うか、host 限定の新キー。
  3. 許可外パス: throw 箇所（`src/media/local-media-access.ts` A:150/181/201/252・B:147/178/198/241、`src/media/web-media.ts` A:1170 / B:1153）に、許可 root・「workspace へコピー」・`tools.fs.workspaceOnly` を足す。許可 root を足すユーザー設定のキーを `media-tool-shared.ts`（A:558 / B:475）の `localRoots` へ。
  4. ユーザーへの警告: `src/agents/embedded-agent-runner/run/tool-error-warning.ts`（`includeError` A:56 / B:62、`buildFailureWarning` A:298 / B:21）に、返事が無い時だけ短い理由を足す。
  5. loop の既定: `src/agents/tool-loop-detection-config.ts:15-31`（A・B 同一）を `global ?? { enabled: true }` に。今の回避策は設定 `tools.loopDetection.enabled: true`。
  6. 引数が変わる失敗: `src/agents/tool-loop-detection.ts` の error 分岐（A:303 / B:311）に、URL・パスを除いた失敗の同一性で数える streak（警告 4〜5・ブロック 8 程度）。
  7. 止まらない origin: `src/media/web-media.ts`（A:1083 / B:1066）に `responseHeaderTimeoutMs` を通し、pdf tool から 30〜60 秒。
- 9.7: CHANGELOG に pdf の 401・local roots・loop の既定の変更は無い。

### F6（A 9/15・B 10/15）

- A だけ不通: F6.1 `src/channels/typing-lifecycle.ts:48` の `stop()` が `tickInFlight=false` に戻し、再起動後に typing の呼び出しが 2 本重なる。**9.7 で直っている**（B は通る。9.7 の CHANGELOG には記載なし・コード上の差）。
- A・B とも不通: F6.2（controller のループ 6 秒と callbacks のループ 3 秒が積み重なり、6 秒ごとに start() が同時に 2 回。実害は小さい）、F6.3（followup／collect で 2 通目が queue から実行される間、typing が出ない＝26 秒の無信号。msg2 の dispatch 終了時に `dispatch.ts:403-404` が controller を閉じ、queue 実行は閉じた controller を使うため）、F6.4・F6.4s（msg2 が msg1 の typing の最中に自前の start/stop を出す。Matrix 系の plugin は stop で部屋全体の typing を消す）。
- 直しの patch: `patches/f6-typing-no-overlap-no-stray-stop.patch`（B 用・4 ファイル: `dispatch.ts`・`agent-runner-run.ts`・`reply-dispatcher.ts`・`reply/typing.ts`）。B に当てて F6.3・F6.4・F6.4s が PASS（F6.2 は直らない・record の F6.3d は固定値が変わる）、同領域の既存 unit 72 ファイル・1817 件が通る（試作時の確認）。`TypingController` に `hasStarted` を足すので mock にも足すか optional に。e2e `agent-runner.runreplyagent.e2e.test.ts` の "keeps typing alive when a followup is queued behind a live active run" は旧動作を固定しているので更新が要る。**A には素では当たらない**（`agent-runner-run.ts` の文脈が違う）。
- plugin 側（core では試験できない）: `messages.ackReaction`・`ackReactionScope`・`statusReactions.enabled`、各 plugin 自前の「処理中」文言。core は積まれた 2 通目に対する「処理中」文言を出さず、これらの helper も呼ばない（F6.4r）。**本番で別々に出た「処理中」の重複は plugin 側の可能性が高い**。
- 設定: `messages.queue.mode`（steer／followup／collect／interrupt）。`messages.queue.byChannel.lineworks` は schema が `Unrecognized key` で拒否する（許可の channel は固定の列挙。LINE WORKS はグローバルの `mode` か、`zod-schema.messages.ts:48-65` の record 化が要る）。`messages.queue.debounceMsByChannel.lineworks` は通る。`agents.defaults.typingMode`（mention 情報が無い group は `message` になり、積まれた 2 通目は typing を出さない）・`typingIntervalSeconds`（正の整数）。

## 9.7 の同梱の機能・設定で直る物（名指し）

- **素の 9.7 で自然に直る**: F6.1（typing の重なり）だけ。F3 は 9.6 の時点で直っている（FIFO lease）。
- **設定で直る**（9.6・9.7 とも同じキー。9.7 の新機能ではない）:
  - F1: `surfaces.<channel>.silentReply.group = "allow"`
  - F5: `tools.loopDetection.enabled = true`（同一の失敗の繰り返しだけ。引数が変わる回り道は止まらない）。`tools.fs.workspaceOnly`（`false` で既定の root 下が開く。許可 root を足すキーは無い）。
  - F4: `agents.defaults.model.fallbacks` を別の枠の候補にする（待たずに別の枠で続ける）。
  - F3: `messages.queue.mode = followup | collect`（既定の steer でも欠落はない）。
  - F6: `agents.defaults.typingIntervalSeconds`（重なりの緩和のみ）・`agents.defaults.typingMode`。
- **9.7 でも直らない（直しが要る）**: F2（通知が無い）・F4（復帰時刻の表示・自動再開。B には分類の移植も）・F5（401 の案内・認証 header・許可 root・止まらない origin・回り道の停止・ユーザーへの理由）・F6（積まれた 2 通目の typing・stray stop）。

## 未確認・限界

- 本物の gateway・channel plugin・Claude CLI は走らせていない（seam で本物の core を動かし、外側を偽にした）。LINE WORKS の plugin 側の挙動（`MessageSid` に何を入れるか・どの dispatcher を使うか・mention の渡し方）は未確認。
- F2 の `message_tool_delivery_missing` の経路と、requester が起きた後に最終返信へ画像が載るかは未確認。F4 の stream-json の形は repo のテスト用 fixture に従った（実物の捕捉ではない）。F6 の「無信号 10 秒まで許容」「1 回の start で 6 秒見える」は私の仮定。
- B の F2 は SQLite worker の host broker が vitest の thread で起動しないため、試験内に `isMainThread` の shim を入れている（A には当てていない）。
- patch は B に当てて確認した物（F4 の 2 本・F6）。F2・F5 の直しは案（F2 は A への一時的な差し込みで確認）。
