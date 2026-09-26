# 2026-09-27 — Continuity after the 8-hour idle reset (9.6), cron description, memory write gate

Branch line (everything stacks on one 9.6 line):

```
v2026.9.6 ── sparx/carry-2026.9.6 (#10: 5 carry commits + d22ceb6a4 quota classifier)
                 └─ Part A cherry-picks (36418cb43, 0520a6589, 100564050  = b7babf556, e9c026191, 10bf94470)
                      ├─ sparx/continuity-9.6       (#11, Part B)
                      └─ sparx/memory-write-gate-9.6 (Part C)
                 └─ sparx/cron-description-9.6     (#12, Part E; based on the carry head before d22ceb6a4)
```

The earlier remote `sparx/continuity-9.6` only held the Part A commits (no Part B work survived the
usage-limit stop). It was replaced with a lease (`--force-with-lease` on `10bf94470`) by carry + Part A.

## 1. What actually reaches the model on the claude-cli path (verified in 9.6 source)

The upstream docs call the CLI backend a text-only fallback. Our bots run `claude-cli` as the
primary path, so every mechanism below was checked in 9.6 source, not taken from the docs.

| Mechanism | Effect on claude-cli in 9.6 | Evidence |
|---|---|---|
| memory flush | never runs on CLI turns | `src/auto-reply/reply/agent-runner-memory.ts:1226` (`!isCli`) |
| `contextInjection` | only read by the embedded runner; CLI prompt preparation ignores it | `src/agents/bootstrap-files.ts:70`, `embedded-agent-runner/run/attempt-bootstrap-prepare.ts:44`; no use under `src/agents/cli-runner/` |
| `startupContext` | only on a bare `/new` or `/reset` (or soft reset), never on automatic idle/daily expiry | `src/auto-reply/reply/get-reply-run-context.ts:316,353` |
| compaction | owned by Claude Code for CLI backends | docs/gateway/cli-backends.md "Native compaction ownership" |
| session notes (`custom_message` after the latest boundary) | prepended to every turn, **2,000-char cap**, drops older notes | `src/agents/cli-runner/session-history.ts` `renderCliDurableContext`, `MAX_CLI_DURABLE_CONTEXT_CHARS` |
| fresh-session reseed | only with a compaction summary or `reseedFromRawTranscriptWhenUncompacted` | `session-history.ts` `loadCliSessionPromptContext`, `prepare.ts:2137` |
| CLI history account gate | **refuses every transcript-derived context** unless the session's account proof covers the transcript tip, or the branch is a proven-empty start | `src/agents/cli-runner/history-boundary.ts:36-124` |

What an automatic idle reset does in stock 9.6:
- It keeps the same transcript id: `src/auto-reply/reply/session.ts:838`.
- It appends a `reset` boundary (`preserve-tail`, 6 retained user/assistant records) inside the guarded lifecycle transaction: `session-accessor.sqlite-reset-boundary.ts`, called from `session-accessor.sqlite-projection.ts:445`.
- It clears the native CLI binding in the same commit: `session.ts:1125`.
- It builds the new entry without `cliHistoryBoundary`.

**Result in stock 9.6:** after an idle reset the claude-cli model receives only the new user message:
- The account gate sees no proof, and the retained tail means the branch is not "proven empty", so
  `historyAllowed=false` / `rawTranscriptReseedReason="auth-unknown"`.
- The session notes, the reseed and the retained tail are all refused.
- Later turns stay refused, because nothing restores the proof.

This was confirmed by the Part B integration test before the proof carry was added: the fresh
prompt was exactly the user message.

## 2. Part B: what is connected (file:line on `sparx/continuity-9.6`, commit 98431d25c)

| Role | Real 9.6 component | Change |
|---|---|---|
| trigger | reply session initializer, automatic stale rollover | `src/auto-reply/reply/session.ts:1041-1044` requests `continuity: true` only for idle/daily (not `/new`, `/reset`, cron-stale, restart recovery) |
| store + atomicity | guarded SQLite lifecycle transaction that appends the reset boundary and writes the entry | `session-accessor.sqlite-reset-boundary.ts:61-104`; the record is appended right after the boundary in the same `appendTranscriptEventsInTransaction` call; the entry write in `session-accessor.sqlite-projection.ts:445-454` is in the same transaction |
| reader (pre-reset window) | transcript rows after the previous reset only | `session-accessor.sqlite-read.ts:389` `loadTranscriptEventsSinceLatestReset` |
| record builder | new, pure, no model call | `src/config/sessions/session-continuity-record.ts` |
| account proof | `cliHistoryBoundary` on the session entry | `session-accessor.sqlite-reset-boundary.ts:61-95`: extended over the runtime-written reset+record rows only when the previous lifecycle's known proof covered the exact tip (`maxSeq` and `generation`); otherwise the stock refusal stands |
| caller (prompt) | `prepareCliRunContext` | `src/agents/cli-runner/prepare.ts:2040,2045,2064`: `freshCliSession: !reusableCliSessionId`; the record is prepended before the session notes |
| CLI reader | `loadCliSessionPromptContext` | `src/agents/cli-runner/session-history.ts:454,501-523,529-588`: the record is excluded from the 2,000-char notes and rendered by itself for fresh native sessions only |
| finalizer / binding | `persistCliSessionBindingResult` (lifecycle CAS on sessionId + lifecycleRevision + activeWriterRunId) | unchanged; the test proves a pre-reset run finishing late cannot publish, and the post-reset run can. Until a post-reset binding exists, every fresh turn gets the record again (at-least-once, no guessing) |

Record contents (`session-continuity-record.ts`):
- **Unfinished requests.** Consecutive user messages form one turn. Status is mechanical: `unanswered`, `interrupted` (aborted/error/length), `tool-pending` (a call without a result), or `replied`, which is excluded from this list and means only that the reply ended normally.
- **Side effects and save locations.** Taken from tool-call arguments and tool-result details: path, folder, URL, target, job id and similar. Read-only tools are ignored. The outcome is `ok`, `error` or `no-result`, and the record says "do not repeat an ok one".
- **User statements in order.** Stated rule: a later statement overrides an earlier one on the same point.
- **Retrieval.** `sessions_history` with sessionKey, sessionId and anchor entry ids. The ids are the transcript entry ids exposed as `__openclaw.id`: `src/gateway/session-transcript-entry-message.ts:37-60`.
- **Budget.** 8,000 chars. The oldest statements are dropped first, then the oldest unfinished requests; the newest is never dropped. Every omission is listed by entry id and marks the record `Coverage: PARTIAL`. If even that does not fit, or the window cannot be read, an explicit "Coverage: NONE, retrieve or ask, do not guess" record is written, and the reset still commits.

### Evaluated separately

| Scenario | Stock 9.6 | With Part B | Test |
|---|---|---|---|
| New start after 8h expiry, first fresh CLI turn | only the user message (16 chars in the fixture) | record + user message: 1,580 chars (~400 tokens chars/4); record 1,398 chars | `session-continuity.test.ts` "restores the save location…" |
| Resume inside the window (native session reused) | current prompt + notes | unchanged; the record is **not** resent | "does not resend the record on a resumed turn" |
| Fresh native session inside the window, no expiry | stock reseed/notes path | unchanged; no record is written | "does not write a record for a fresh session inside the window" |
| Fresh native session later in the same post-reset window (binding lost) | nothing (gate refused) | record again (at-least-once) | "publishes the new native binding only from the post-reset lifecycle" |

Input cost: at most 8,000 chars of record (~2k tokens), only on fresh CLI turns after an automatic
reset, never on resumed turns. A character cap is not treated as evidence of sufficiency: coverage
is stated in the record itself, and omissions carry retrieval anchors.

Relation to the earlier R1 evidence (7.1-2): the private R1 candidate targeted the ~99k-token
re-injection when a fresh CLI session reseeds the whole history *inside* the window. Part B does
**not** change that path. It addresses the post-expiry start, where 9.6 currently injects nothing.
The R1 contract ideas that carry over are rewritten for 9.6, not ported:
- authority read from the real store
- no replay after a fresh attempt starts
- binding committed only by the real lifecycle-guarded finalizer
- fallback to the existing route when state is missing

### Capability contract mapping (H1–H5, B1–B8)

| ID | How Part B relates | Status |
|---|---|---|
| H1 known conversation key | record derived from the same session's transcript only; retrieval anchors are in that conversation | tested (integration) |
| H2 metadata selection | not changed | n/a |
| H3 ambiguous candidates | record never selects a conversation; says "retrieve, do not guess" when partial or unavailable | unit-tested |
| H4 permission / other tenant / missing key | account gate honored: a different account gets neither the record nor the save path; sessions_history keeps its own access checks | tested (account); other tenant = other session key, structurally isolated, **not separately tested** |
| H5 new statements / condition changes | statements in order with an explicit override rule; the post-reset message is the current turn after the record | tested |
| B1 save request | save locations and outcome carried; "do not repeat an ok one" | tested (prompt contains path/folder/link) |
| B2 search | not changed | n/a |
| B3 image generation / reply | not changed; image skills untouched | n/a |
| B4/B5 resale flows | not changed; an interrupted request is carried as unfinished | partially (generic) |
| B6 memory / proper nouns | quoted verbatim from the transcript with entry ids | tested (verbatim) |
| B7 reservations / reminders | a pending booking call is shown as `no-result`, never as done; no duplicate reservation | unit-tested |
| B8 Session Log / pinned buttons | not changed | n/a |
| S (idle reset stays 480) | not changed; `idleMinutes=480` untouched | n/a |

### Untested / unverified (Part B)
- No model ran. That a model actually completes the same deliverable from the record needs a model-in-the-loop evaluation on isolated fixtures.
- That `sessions_history` anchored reads (`messageId` + `sessionId`) return entries from before the reset boundary has not been verified.
- Sessions whose account proof is already `unknown` at deploy time won't receive the record on their first post-deploy expiry. The proof only exists after a proven-empty start (e.g. `/new`). In that case the record is still written to the transcript, but claude-cli refuses it, exactly as stock.
- Plugin-owned execution transport: the record travels in `promptContext.prependContext`. It is covered by the stock durable-context tests, **not** by a continuity-specific test.
- Group sessions: the record includes all participants' statements, the same visibility as the transcript. There is no per-sender filtering.

## 3. Part E: cron tool description (#12, commit 5476765e2)

- Rewritten from the 9.6 source text (`src/agents/tools/cron-tool.ts:179-218`); the old dist diff was not applied.
- Triggers on: 5,324 → 5,162 chars (~1,331 → ~1,291 tokens, chars/4). Triggers off: 4,768 → 4,561 chars. Management-only: unchanged.
- The 9.6 text is already dense, and most of it is asserted word for word by upstream tests. The 7.x evidence (1,939 → 1,551 model tokens) does not carry over.
- Execution-path isolation: sha256 of the parameter schema, output schema, `String(execute)` and name/label/summary for three setups was identical before and after (throwaway test, not committed).
- Constraint preservation test in `cron-tool.test.ts`. 315 cron tests pass; prompt snapshots regenerated.
- Not rerun: the 10-case model tool-selection evaluation.

## 4. PR #10 risk R1: quota messages (commit d22ceb6a4 on sparx/carry-2026.9.6)

- Both production shapes ("…hit your session limit · resets …", "…hit your limit · resets …", with straight or curly apostrophe) were unclassified: `classifyFailoverReason` returned null, the reason became `unknown`, which is treated as transient, so announce turns were replayed (4 runs in the test).
- Now: `src/agents/failover/message-patterns.ts:48,129` classifies them as `rate_limit`, and `src/agents/failover/retry-evidence.ts:133` gives them a long window, so the 43e6f7692 guard stops the replay (1 run).
- Negative cases stay unclassified. 1,664 failover/announce tests pass.

## 5. Part C: memory write gate

See the Part C section appended below.

## 6. Part D (design only): measuring "the same correction is never needed twice"

1. **Correction events.** Detect a user turn that corrects the previous assistant output. Signals:
   - an explicit correction phrase, plus an edit-distance/entity overlap with the prior assistant turn
   - a user edit of a delivered artifact
   - a re-request of the same deliverable with a changed condition

   Store each as `{sessionKey, entryId, correctedEntryId, normalized claim/condition key, timestamp}`.
   The key is deterministic: entity + attribute, e.g. `deck.slide3.price` or `recipient.honorific`.
2. **Repeat detection.** A repeat is a later correction event with the same key in the same scope (conversation, or tenant for durable facts) after the first was acknowledged. Report per key:
   - first-seen
   - repeats
   - time and sessions between repeats
   - whether a reset or compaction happened in between
3. **Attribution.** For each repeat, record whether the first correction was available to the model:
   - present in the continuity record / memory with a source
   - retrieved via a tool
   - absent

   A repeat while the correction was present means behavior. A repeat while it was absent means carry-over (Part B/C).
4. **Metric.** repeats / corrections per 100 conversations, split by attribution. Plus zero-repeat coverage: the share of correction keys never repeated within 30 days.
5. **Evaluation.** Build isolated replay fixtures from real correction pairs, with customer data replaced. Re-run them after each change and compare repeat rate before and after with the same inputs. Natural-traffic observation does not replace this.

## Upstream vs carry

Everything here is SPARX carry on the 9.6 line; nothing was sent upstream.

Candidates worth proposing upstream later, as issues first and only after an owner decision:
- the account proof being dropped on automatic reset
- the unclassified Claude CLI quota notices
- the startupContext / automatic-reset gap
