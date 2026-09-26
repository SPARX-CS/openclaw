# Runaway completion delivery: LINE WORKS DM, 2026-09-26 21:48–22:00 JST (independent analysis)

This is the second, independent analysis. The Sonnet routine `openclaw-runaway-delivery` did the first.
Sources:
- Production `2026.7.1-2`: upstream tag `v2026.7.1-2`, commit `0790d9f593a`.
- Target `2026.9.6`: upstream tag `v2026.9.6`, commit `eb377ac59e6`.
- Fixes are built on fork `main` `8eed7e85638`, which is later than `2026.9.6`.

Paths below are relative to the repository root. `7.1:` means the `v2026.7.1-2` tree and `9.6:` means the `v2026.9.6` tree.

Every claim was checked against source. **Inference** marks what source alone cannot prove, and **UNVERIFIED** marks what was not run. I had no access to the production journal or transcripts. The incident facts come from the task description.

## TL;DR

- **The whole loop in 7.1-2 comes from one fingerprint mismatch.** User turns hash the CLI "message policy" as `{sourceReplyDeliveryMode:"automatic", requireExplicitMessageTarget:false}`. Completion hand-off turns hash either `{"message_tool_only", false}` (subagent completion into a DM) or `{requireExplicitMessageTarget:false}` alone (image_generate completion). That mismatch invalidates reuse on every completion.
- **Nothing breaks the loop.** Completion turns are "user-facing-state preserving", so they never save the new CLI session they create. Every later completion hits the same stale binding and reseeds the full transcript again.
- **Timeouts make it worse.** In 7.1-2 the announce timeout does not cancel the turn it started, so retries overlap with turns that are still running.
- **Quota exhaustion then wipes the binding.** Any `FailoverError` clears the main CLI binding, including the one this turn never resumed.
- **2026.9.6 fixes steps 3, 5 (partly) and 6** (commits below). One remaining step-5 defect is fixed in PR #4. One design gap remains (D.2).
- **Immediate mitigation: section C.** The safe, verified stop is `tools.deny`. `announceTimeoutMs` and, on 7.1-2 only, the reseed flag reduce the blast radius.

---

## C. Immediate mitigation (no code change)

Apply to `openclaw.json` and restart the gateway. The status column means:
- **VERIFIED**: I read the code that consumes the key.
- **UNVERIFIED**: not exercised end-to-end.

### C.1 — 2026.7.1-2 (production now)

| # | Key / value | Effect | Proof (7.1 tree) | Status |
|---|---|---|---|---|
| 1 | `tools.deny: ["sessions_spawn", "image_generate"]` (or per agent: `agents.list[<main>].tools.deny`) | claude-cli only sees OpenClaw tools through the MCP loopback, and the loopback tool list goes through the deny pipeline. The model then cannot spawn workers or generate images, so the chain cannot start. | Schema `src/config/zod-schema.agent-runtime.ts:758-762` and `:1091`. Reader `src/agents/agent-tools.policy.ts:378-436`. Applied to the loopback in `src/gateway/tool-resolution.ts:79,137-148` via `src/gateway/mcp-http.runtime.ts:47-51`. | VERIFIED (code path). Strongest stop. |
| 1b | Narrower: `tools.subagents.tools.deny: ["image_generate"]` | Keeps delegation but stops workers from generating images. The main agent can still call image_generate itself. | `agent-tools.policy.ts:91-112`, schema `zod-schema.agent-runtime.ts:1123` | VERIFIED (code path) |
| 2 | `agents.defaults.subagents.announceTimeoutMs: 600000` | The in-process `agent` hand-off times out after 120 s by default. In 7.1-2 that timeout is only a `Promise.race`, so the turn keeps running and still replies to the user while the announcer retries. A longer deadline removes most timeout-driven duplicate turns. | Reader `src/agents/subagent-announce-delivery.ts:343-345`, used at `:1571`. Race-only timeout at `src/gateway/server-plugins.ts:389-411,469,520-531`. | VERIFIED (code path); the value 600000 is a judgment call |
| 3 | `agents.defaults.cliBackends["claude-cli"]: { command: "claude", reseedFromRawTranscriptWhenUncompacted: false }` | When reuse is invalidated (the message-policy case) and the session has no compaction, the new claude-cli session gets no raw transcript tail. That stops the ~42k-character replay and the old `MEDIA:` lines, which is what re-sent old images. **Cost:** completion turns lose conversation context. After a compaction, the summary plus later messages are still replayed. `command` is required by the schema and must match your installed binary. | Schema `src/config/zod-schema.core.ts:809-856,844`. Bundled default `true` at `extensions/anthropic/cli-backend.ts:78`. Reader `src/agents/cli-runner/prepare.ts:948-966`. Gate `src/agents/cli-runner/session-history.ts:564-583`. | VERIFIED (code path); UNVERIFIED end-to-end |
| 4 (optional, behavior change) | `messages.visibleReplies: "message_tool"` | Makes the three turn kinds hash the same: user DM turns, subagent completions and media completions all resolve `message_tool_only`. Completion turns then **resume** the main claude-cli session instead of reseeding. **Cost:** the main agent's final text is no longer auto-delivered in the DM. It must call the `message` tool, so `message` must not be denied. | User turns: `src/auto-reply/reply/source-reply-delivery-mode.ts` (DM branch) and `get-reply-run.ts:710-715`. Subagent completion: `subagent-announce-delivery.ts:1395-1402,1448-1450`. Media completion: `auto-reply/reply/completion-delivery-policy.ts:40-57`. Hash: `cli-runner/prepare.ts:417-438`. | UNVERIFIED end-to-end. **Staging only.** The LINE WORKS plugin's own reply-mode handling was not inspected. |
| — | Values that do not help | `maxChildrenPerAgent` caps active children only (one worker made 11 calls). `maxSpawnDepth` has a minimum of 1. `tools.loopDetection` detects identical repeated calls, not fresh turns. There is no key to disable completion announces or to change the announce retry count (constants at `subagent-announce-delivery.ts:225-229` and `subagent-registry-helpers.ts:42-45`). | — | VERIFIED (absence) |

```json5
// 2026.7.1-2
{
  tools: { deny: ["sessions_spawn", "image_generate"] },
  agents: {
    defaults: {
      subagents: { announceTimeoutMs: 600000 },
      cliBackends: { "claude-cli": { command: "claude", reseedFromRawTranscriptWhenUncompacted: false } },
    },
  },
}
```

### C.2 — 2026.9.6

| # | Key / value | Effect | Proof (9.6 tree) | Status |
|---|---|---|---|---|
| 1 | `tools.deny: ["sessions_spawn", "image_generate"]` (or `tools.subagents.tools.deny: ["image_generate"]`) | Same as C.1 #1. | Schema `src/config/zod-schema.agent-runtime.ts:621-627,756,816`. Reader `src/agents/agent-tools.policy.ts:383-416,100-116`. Loopback `src/gateway/tool-resolution.ts:146,257-273`. | VERIFIED (code path) |
| 2 | `agents.defaults.subagents.announceTimeoutMs: 600000` | In 9.6 the deadline only covers the time until Gateway admission. The timer is cleared on accept or execution start, and an unaccepted run is cancelled. Raising it mainly avoids a cancel-and-retry while the requester lane is busy. Lower value than on 7.1-2. | `src/agents/subagents/announce/subagent-announce-delivery-retry.ts` (`resolveSubagentAnnounceTimeoutMs`). Cancel and clear in `subagent-announce-completion-delivery.ts:66-121`. | VERIFIED (code path) |
| — | **Do not** carry over `agents.defaults.cliBackends` | Retired in 9.6: the schema rejects it and Doctor deletes it. There is no config-only way to switch off replay in 9.6. It should also be unnecessary, because the message-policy split is fixed (A.3). | `src/commands/doctor/shared/legacy-config-migrations.runtime.cli-backends.ts:11-31` | VERIFIED |
| — | `messages.visibleReplies` | Not needed for hash stability in 9.6 (A.3). | — | — |

```json5
// 2026.9.6
{
  tools: { deny: ["sessions_spawn", "image_generate"] }, // until PR #4 is carried and D.3 scenarios pass
  agents: { defaults: { subagents: { announceTimeoutMs: 600000 } } },
}
```

---

## A. Root cause by step (file:line)

### Step 2 — "requester could not be woken, `no_active_run`" → requester-agent hand-off

- **7.1:** `src/agents/subagent-announce-delivery.ts:1462-1497`. The code queues into the active run when `requesterActivity.isActive`. When that run has already ended, it logs the warning at `:1497` and falls through to a direct `agent` call (`directAgentParams`, `:1531-1560`) with `forceSyntheticClient` (`:141`) and `inputProvenance.kind = "inter_session"`.
- **9.6:** same fallback at `src/agents/subagents/announce/subagent-announce-direct-delivery.ts:337`, with `forceSyntheticClient` at `subagent-announce-completion-delivery.ts:92`.
- **Verdict:** this is intended behavior in both versions. The fallback is not the defect; the problem is what each hand-off turn does (steps 3–6).
- **Inference:** `image_generate` records the *calling* session as the media requester (`media-generate-background-shared.ts` in both trees). The worker's own image completions therefore also ran turns in the worker session. That may explain why the same image was generated 3×: the worker lost track of earlier calls through the same reseed mechanism. The worker's transcript was not available to check.

### Step 3 — `reuse=invalidated:message-policy`, `useResume=false`, new claude-cli session every time

**The check.** `src/agents/cli-session.ts` (7.1 `:178-181`, 9.6 `:268-270`) invalidates reuse when the stored `messageToolPolicyHash` differs from the current one. The hash is computed in `src/agents/cli-runner/prepare.ts` (7.1 `:409-438`, 9.6 `:929-961`) as `sha256(JSON.stringify({sourceReplyDeliveryMode, requireExplicitMessageTarget}))`. `JSON.stringify` drops `undefined` keys.

**Why user turns and completion turns differ in 7.1-2:**

| Turn | Path | Hashed object |
|---|---|---|
| User DM turn (LINE WORKS → dispatch) | `dispatch-from-config.ts:3400` injects the session-stable mode (`automatic` for a DM on claude-cli, since only the codex harness defaults to `message_tool`: `extensions/codex/harness.ts:61`). `get-reply-run.ts:710-715` records it as the binding fact. | `{"sourceReplyDeliveryMode":"automatic","requireExplicitMessageTarget":false}` |
| Subagent completion hand-off | Gateway `agent` → `agents/command/attempt-execution.ts:722-723` passes the request's mode and `requireExplicitMessageTarget:false`, with **no binding facts**. The request mode is `message_tool_only` for a DM completion (`subagent-announce-delivery.ts:1395-1402,1448-1450`). | `{"sourceReplyDeliveryMode":"message_tool_only","requireExplicitMessageTarget":false}` |
| image_generate completion hand-off | Same path. `completionRequiresMessageToolDelivery` is false for a DM with default config, so no mode is sent. | `{"requireExplicitMessageTarget":false}` |

All three hashes differ, so every completion turn gets `invalidate: message-policy`.

**Control case (`openclaw agent` CLI).** Both the user turn and the late completion go through the same agent-command path with the same inputs, so they produce identical hashes. The session is resumed, which matches what you observed. **Inference** consistent with source; not replayed.

**Why it never recovers (the loop).**
- The hand-off request sets `preserveUserFacingSessionModelState` for completion provenances (7.1 `gateway/server-methods/agent.ts:1250-1252`; `input-provenance.ts` lists `image_generate`, `subagent_announce`, …).
- With that flag, the agent-command session update skips the CLI binding write entirely (7.1 `agents/command/session-store.ts:177,185-195`; `agent-command.ts:2476-2477`).
- So the new claude-cli session created by a completion turn is never recorded. The stored binding stays the user-turn binding with the `automatic` hash, and the **next** completion invalidates again, starting yet another session.
- Each new session is reseeded from the OpenClaw transcript (`cli-runner/session-history.ts:265`, "Continue this conversation using the OpenClaw transcript below…"). The raw-tail reseed is allowed for `message-policy` (`session-history.ts:62-78`) because of the bundled `reseedFromRawTranscriptWhenUncompacted: true`.
- The transcript contains earlier assistant `MEDIA:` replies. A fresh model that doesn't know they were already delivered re-emits them, which is how duplicate images and apologies reached the user. **Inference** for the re-emission itself: model behavior, not provable from source.

**2026.9.6:**
- **Fixed for message-policy.** Synthetic `inter_session` / `internal_system` / heartbeat turns now derive the same session-stable mode as dispatch:
  - `agents/command/prepare.ts:328-347` calls `resolveSessionStableReplyMode` (`auto-reply/reply/session-stable-reply-mode.ts`).
  - `prepare.ts:936-945` ignores per-turn `requireExplicitMessageTarget` when binding facts exist.
  - Commits: `47640e06be1` (#120108, 2026-08-06) and `5235269b3c3` (#121509, 2026-08-12). Both are ancestors of `v2026.9.6` and not of `v2026.7.1-2` (checked with `git merge-base --is-ancestor`).
  - Pinned by `src/commands/agent.test.ts` "keeps synthetic direct-DM delivery mode out of existing CLI binding facts".
- **Still present (design gap, see D.2).** Preserved completion turns still never save a new CLI session (`agents/command/run-embedded-attempt.ts:487-489` → `attempt-execution.ts:973`). Upstream made this choice on purpose in `c103dbc94f2` (#136644: "heartbeat and explicitly preserved turns retain the prior native binding"), and it is pinned by `attempt-execution.cli.test.ts` "settles a cold preserved-state CLI binding…". Consequence: if *any* other fingerprint (`cwd`, `mcp`, `auth`, missing transcript) ever differs on completion turns only, 9.6 reproduces the per-completion full reseed loop.
- **UNVERIFIED for your LINE WORKS plugin.** If the plugin passes an explicit `replyOptions.sourceReplyDeliveryMode` on normal DM turns, dispatch treats it as the stable mode (`source-reply-delivery-mode.ts` `hasStableTurnOverride`). Completion turns derive the mode from config instead, so the hashes could split again. Check the plugin source, or check that `reuse=` on completion turns in 9.6 staging logs reads `reuse` / `reuse-with-drift`, not `invalidated:*`.

### Step 5 — "gateway request timeout" → "transient failure, retrying n/4" → same run restarts at 2/4

**Inner loop.** `runAnnounceDeliveryWithRetry`: 7.1 `subagent-announce-delivery.ts:533-561` (log `:552`); 9.6 `subagent-announce-delivery-retry.ts:241-279`.
- Delays are 5/10/20 s, for 4 attempts.
- The counter is local and not persisted, so any outer re-invocation starts again and logs "2/4".

**Outer re-invokers (why the same run id restarts).**
- **7.1 subagent registry:** `MAX_ANNOUNCE_RETRY_COUNT = 3` with 1–8 s backoff (`subagent-registry-helpers.ts:42-45,69-76`, decided in `subagent-registry-cleanup.ts:41-79`). Give-up can also *suspend* the delivery and replay it later as steering (`subagent-registry-lifecycle.ts:670-718`).
- **9.6 subagent registry:** no count cap. Backoff is 15 s doubling to 5 min, until 30 min after the deadline (`registry/subagent-registry-helpers.ts:34-46`, `registry/subagent-registry-cleanup.ts:49-92`).
- **9.6 media:** a pending-wake loop (`media-generate-background-shared.ts:159-184`), plus the durable session-delivery queue (`MAX_SESSION_DELIVERY_RETRIES = 5`, `infra/session-delivery-queue-recovery.ts:47`).
- Media run ids are `image_generate:<taskId>:<status>` (7.1 `media-generate-background-shared.ts:537,585`), which matches the journal.

**Why retries produced duplicates in 7.1-2.**
- The hand-off `agent` request is fired with `void handleGatewayRequest(...)`, and the timeout is only a `Promise.race` (`gateway/server-plugins.ts:389-411,469,520-531`).
- A "timed out" attempt therefore keeps running, delivers its reply, and the retry starts another full turn.
- Gateway dedupe (`server-methods/agent.ts:1260-1297`) returns `in_flight` only while the first run is live, and cached results expire after 5 min (in memory only).

**Classifier mismatch (UNVERIFIED which message was logged).** In both trees, "gateway request timeout for agent" does **not** match the transient patterns (`/gateway timeout/i`). The lines that retried must have carried another message. In 7.1-2 the likely ones are `all models failed` or `overloaded` (`subagent-announce-delivery.ts:369-381`); both match, and they explain retries continuing after the quota ran out at 21:53:59. Please grep the journal for the text after "transient failure, retrying n/4:".

**2026.9.6:**
- **Largely fixed.** The deadline cancels an unaccepted run and is cleared once the run is accepted, so there are no orphaned "timed-out" turns (`subagent-announce-completion-delivery.ts:66-121`, `internal-facade.ts:316-324`). Retries are skipped when there is send evidence (`subagent-announce-delivery-retry.ts:146-151`). Generated media with attachments goes through the durable queue instead of this loop.
- **Remaining defect, fixed in PR #4.** `isTransientFailoverAnnounceError` (9.6 `subagent-announce-delivery-retry.ts:128-132`) treats **any** fallback-exhausted `FailoverError` (`attempts.length > 0`) as transient, including all-`billing` (quota), `auth_permanent` and `model_not_found`. After the quota ran out, each announce kept replaying the requester turn 4× per registry cycle, and in 9.6 registry cycles continue for up to 30 min.

### Step 6 — "CLI session cleared after failed reused turn" → main binding wiped (memory loss)

**7.1:** `agents/command/attempt-execution.ts:776-796`.
- On error it clears the stored binding when `shouldClearReusedCliSessionAfterError` (`:75-80`) is true. That covers **any** `FailoverError` (rate_limit, billing, timeout, …) and any `AbortError`.
- The only condition is that a binding *exists* (`activeCliSessionBinding?.sessionId`), not that this turn resumed it.
- In the incident the completion turn had `useResume=false` (message-policy), so it failed on quota in a *different, new* session and still deleted the main binding. The log text "failed reused turn" is misleading here.

**9.6: fixed.**
- `shouldClearFailedCliSessionBinding` (`cli-session.ts:155-176`) clears only for failover reason `session_expired` (`:22-26`), or for `AbortError` when the binding was replaced during the run. It also never clears while new detached media is pending (`:165-167`).
- Call site: `agents/command/attempt-execution.ts:938-968`.
- Commit `e2deb87c305` (#128732, 2026-08-25) is in `v2026.9.6` and not in `v2026.7.1-2`.

### Summary

| Step | 7.1-2 | 2026.9.6 |
|---|---|---|
| 2 hand-off fallback | by design | by design |
| 3 message-policy invalidation | **bug** (hash split between dispatch and agent-command turns) | fixed (#120108, #121509); preserved-turn no-publish gap remains (D.2) |
| 3b completion turns never save a new binding | present (`session-store.ts:177`) | present by design (`c103dbc94f2`) |
| 5 timeout keeps turn running | **bug** | fixed (cancel on deadline) |
| 5 quota exhaustion treated as transient | yes (regex `all models failed`) | **yes (typed `attempts>0`)** → PR #4 |
| 6 binding cleared on any failover | **bug** | fixed (#128732) |

---

## B. Code fixes (PRs into `SPARX-CS/openclaw` `main`)

| PR | Branch | What | Test first |
|---|---|---|---|
| **#4** | `sparx/opus-fix-5-announce-billing-retry` | Announce delivery only retries a fallback-exhausted `FailoverError` when at least one candidate failed for a transient reason. It reuses the existing owner `shouldUseTransientCooldownProbeSlot` (`src/agents/failover-policy.ts`). Quota, auth and model-not-found no longer replay the requester turn 4×. | `src/agents/subagents/announce/subagent-announce-delivery-retry.test.ts`: failed first (4 calls instead of 1) and passes after the fix. |

**Not opened, deliberately:** a change making preserved completion turns save a new CLI binding (D.2). It reverses an upstream decision pinned by a test (`c103dbc94f2`) and needs a maintainer decision, not a carry patch. See D.2 for the narrower proposal.

---

## D. Design input

### D.1 Upstream vs carry

| Item | Recommendation |
|---|---|
| PR #4 (typed failover retry) | **Upstream.** Generic defect, small, uses the existing policy owner. Carry until merged. |
| Steps 3/5/6 on 7.1-2 | **Don't backport.** The fixes depend on the 2026.8–9 session-store and settlement rework. Upgrade to ≥2026.9.6 and use C.1 until then. |
| D.2 preserved-turn fresh binding | **Discuss upstream first** (issue or design note). Proposal: a preserved turn keeps the prior binding only when it *resumed* it; when reuse was `none`/`invalidate`, it saves its new session. This needs the reuse decision exposed in `agentMeta`. |
| D.4 runaway guard | **Upstream feature proposal**, maybe a plugin-level hook first. |
| LINE WORKS plugin reply-mode check | **SPARX-owned.** The plugin is not in this repo. |

### D.2 Remaining design gap in 2026.9.6

A completion turn that cannot resume the stored binding starts a fresh claude-cli session, reseeds the full transcript, and then discards that session. Consequences:
1. Every later completion repeats the reseed, which is the incident's amplifier.
2. The next user turn resumes a CLI session that never saw the completion. The OpenClaw transcript has it, but the native session does not, which feels like memory loss.

Today this only triggers when fingerprints split for completion turns only. That doesn't happen for message-policy in 9.6, but nothing enforces it for future fingerprint fields.

### D.3 Scenario-level acceptance tests that would have caught this

Run these on every upgrade, as a qa-lab / mock-Gateway scenario with a mocked claude-cli (the `cli-runner` test helpers) and the LINE WORKS plugin or a channel stub using the same reply options.
1. **Completion reuses the main session.** DM on a claude-cli agent: user turn → `sessions_spawn` worker that calls `image_generate` N=8 times → main run ends before the completions. Assert:
   - each completion hand-off logs `reuse=reuse` (never `invalidated:*`);
   - the number of distinct claude-cli session ids is 1;
   - the user receives each image exactly once.
2. **Same as 1 through `openclaw agent`.** Both paths must produce the same `messageToolPolicyHash` for the session. Assert hash equality across dispatch, heartbeat and inter-session turns.
3. **Quota exhaustion mid-stream.** Primary and fallback both return billing or usage-limit errors. Assert:
   - no announce retries for non-transient reasons;
   - the main binding is unchanged after the failure;
   - the next user turn resumes the original session.
4. **Hand-off slower than `announceTimeoutMs`.** Assert at most one requester turn per completion id and no duplicate user-visible message.
5. **Budget.** Cap requester turns caused by completions per session per minute, e.g. ≤ N+2 for N completions. This fails loudly on any future amplification.

### D.4 Missing safety net

Nothing in core limits how many turns completions can trigger in one session. A per-session circuit breaker would have stopped this incident at the first quota error or after K fresh-session reseeds. It could key on completion hand-offs in a time window, repeated fresh-session reseeds, or send volume, and it must emit a visible notice. Today only a gateway restart stopped it.

---

## Comparison with the Sonnet run (`openclaw-runaway-delivery`)

At the time of writing (2026-09-26), its notes branch `sparx/runaway-notes` had no PR. It had opened #2 (`sparx/fix-5-preserve-cli-binding`) and #3 (`sparx/fix-4-synthetic-client-completion`), which I compared against my findings:

- **#3 (save the CLI binding after image/music/video completions, auto-reply path): I agree on the symptom and disagree on scope.**
  - The incident's hand-off goes through the Gateway `agent` method → **agent-command** path (`run-embedded-attempt.ts:487-489`, `attempt-execution.ts:973`). #3 changes only the auto-reply follow-up path (`agent-runner-cli-candidate.ts`), so on its own it would not change the incident path.
  - It also reverses the upstream design pinned in `c103dbc94f2` for media tools. I'd take that upstream as a design question (D.2) rather than carry it.
  - I agree that the underlying cause of the "memory loss" is that completion turns don't save their CLI session.
- **#2 (media-task guard for non-cron session keys): partly agree.**
  - It is right that `getGeneratedMediaTaskIdsForSessionKey` only resolves cron-run keys, so the detached-media guard never engages for DM sessions.
  - But in 9.6 an `AbortError` clears the binding only when the binding was replaced during the run (`cli-session.ts:148-153,172-175`). Its first new test (same session id, `AbortError`) may therefore pass without the fix. Worth confirming it fails first.
  - The production memory loss (step 6) is explained by 7.1-2's clear-on-any-`FailoverError`, which 9.6 already fixed (#128732). It is not explained by the media guard.
- **This run adds:**
  - the exact hash inputs that split in 7.1-2 and the commits that fixed them;
  - the "completion turns never save their session" amplifier;
  - the typed-failover retry defect that remains in 9.6 (PR #4);
  - a 7.1-2-only config lever (`reseedFromRawTranscriptWhenUncompacted: false`).
