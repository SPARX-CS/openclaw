# Runaway image/apology delivery incident — 2026-09-26

**Incident:** LINE WORKS 1:1 DM, 2026-09-26 21:48–21:54 JST. Main agent delegated 8
`image_generate` calls to a spawned worker (`sessions_spawn`) and ended its own reply
turn. As the worker's completions came back one at a time, the user received the same
images and the same apology text repeatedly (mirrored ~10s apart: 21:52:24, :33, :44,
:55, 21:53:23, 21:53:43, …) until the provider quota ran out at 21:53:59 (fallback model
hit the same quota). Only a full gateway restart at 22:00:44 stopped it.

Production: `openclaw@2026.7.1-2` (node 22), `claude-cli` backend, LINE WORKS channel
plugin. Planned upgrade target: `2026.9.6`.

**Two independent analyses of this incident exist.** This one (Sonnet) and a second,
independent one (Opus) on branch `sparx/runaway-notes-opus`
(`sparx-notes/2026-09-26-runaway-delivery-opus.md`, PR #5), which reused the same
tag-diff methodology but read further into the actual completion-handoff call path and
caught two things this analysis initially got wrong. **This file has been corrected
against that analysis** where its file:line citations were independently re-verified
against this source tree (marked below); it is not a blind merge of the two — every
correction here was re-checked directly, not just copied.

**Evidence basis:** no live gateway/journal/transcript access from this session (see
`.claude/skills/openclaw-debugging/SKILL.md`) — everything below is source-code reading
against this fork's checked-out `main` (`8eed7e85`, later than `2026.9.6`) cross-checked
source-to-source against upstream tags `v2026.7.1-2` (`0790d9f593a`) and `v2026.9.6`
(`eb377ac59e6`), fetched read-only from `github.com/openclaw/openclaw` as remote
`upstream`. Log-line strings quoted below are matched verbatim against the incident
report's journal excerpts; anything not fully traced this way is marked **unverified**.

This supersedes the `_(Row 4 …)_` placeholder in `sparx-notes/2026-09-26-upgrade-2026.9.6.md`
(branch `sparx/upgrade-notes`) and reuses/cross-checks the tag-diff methodology already
committed in `sparx-notes/2026-09-26-core-bugs.md` (branch `sparx/notes`).

---

## C. Immediate mitigation (apply today, no code changes) — READ THIS FIRST

**The single strongest lever, on both versions, is to deny the tools that start the
chain:**

```json5
{ "tools": { "deny": ["sessions_spawn", "image_generate"] } }
```
or, narrower (keeps delegation, stops workers specifically from generating images):
```json5
{ "tools": { "subagents": { "tools": { "deny": ["image_generate"] } } } }
```
Deny wins after allow expansion in the tool-policy schema
(`src/config/zod-schema.agent-runtime.ts:142-143`, confirmed present on both versions'
schema; the specific policy-reader/loopback-enforcement file:line citations for each
version came from the parallel Opus analysis and were not independently re-walked line
by line here — treat those specific line numbers as **unverified by this file**, though
the `deny` mechanism itself is confirmed real and structurally verified). This stops the
chain before it starts, at the cost of losing the image-generation feature entirely (or,
with the narrower form, losing it only for spawned workers).

**Second lever — shrink the blast radius without losing the feature**, confirmed
identical in both `v2026.7.1-2` and `v2026.9.6` (same config path, same schema, same
default — verified directly against both tags):

| Config key | Default | Effect | 2026.9.6 source | 2026.7.1-2 source (tag) |
|---|---|---|---|---|
| `agents.defaults.subagents.maxConcurrent` | `8` | Caps concurrent child-agent runs a controller session can have in flight — directly bounds how many simultaneous `image_generate` workers/completions (like this incident's 8) can each independently trigger the handoff/retry chain at once. **Recommended: lower to 1–2.** | `DEFAULT_SUBAGENT_MAX_CONCURRENT` `src/config/agent-limits.ts:25`; resolved by `resolveSubagentMaxConcurrent`, `agent-limits.ts:48-53`; schema `zod-schema.agent-defaults-base.ts:270-277` | Same default/path: `agent-limits.ts:7`; schema `zod-schema.agent-defaults.ts:245` |
| `agents.defaults.subagents.announceTimeoutMs` | `120_000` ms | Per-attempt timeout before one announce-delivery call is treated as transient and retried. **Does not cap the number of attempts.** On 2026.9.6, raising it mainly avoids a cancel-and-retry while the requester lane is busy (the timeout only cancels an *unaccepted* run — see §A point 5). On 2026.7.1-2, the timeout historically raced against a still-running turn rather than cancelling it, so a *shorter* value there just produces more overlapping duplicate turns, not fewer — raise it there, don't lower it. | `DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000` `src/agents/subagents/announce/subagent-announce-delivery-retry.ts:16`; schema `zod-schema.agent-defaults-base.ts:300` | Same key/default, old monolithic `src/agents/subagent-announce-delivery.ts:343-345`; schema `zod-schema.agent-defaults.ts:268` |

**Third lever, `v2026.7.1-2` only (production today):** `agents.defaults.cliBackends`
was a real, schema-backed config key on that version
(`src/config/zod-schema.core.ts` in that tag) that could set
`reseedFromRawTranscriptWhenUncompacted: false` for the `claude-cli` backend, which
would stop the ~42,000-character raw-transcript replay (and the duplicate `MEDIA:`
lines within it) when reuse is invalidated for message-policy reasons — at the cost of
completion turns losing conversation context entirely instead of reseeding it. **Do not
carry this key into `2026.9.6`:** it is retired there and Doctor deletes it on migration
(`src/commands/doctor/shared/legacy-config-migrations.runtime.cli-backends.ts` — file
confirmed present in this tree), and per §A point 3 it should be unnecessary on 9.6
since the actual hash-split that made reseeding trigger every time is fixed there.

**Config keys we looked for and could not find — do not assume these exist on either
version:**
- No config raises/lowers the announce/completion delivery retry ceiling. On
  `2026.7.1-2` it's the hardcoded `MAX_ANNOUNCE_RETRY_COUNT = 3`
  (`src/agents/subagent-registry-helpers.ts:44` in that tag — **directly re-verified
  against the tag for this note**); on `2026.9.6` that constant is gone and nothing
  replaced it except a 30-minute time box. This needed a code fix, not a config change
  — see §B.
- No config disables or dedupes media/text re-attachment for a spawned-worker
  completion replayed through a fresh CLI session.

**If you need to stop an in-progress incident on either version right now:** restart
the gateway for the affected agent (confirmed as the only thing that stopped the actual
2026-09-26 incident). Restated here only because there is no faster config lever.

---

## A. Root cause (2026.9.6 source, cross-checked against 2026.7.1-2)

Steps are numbered as in the incident report. **Point 3 and point 6 below were
corrected after cross-checking the parallel Opus analysis — the corrections were
independently re-verified against this source tree by this analysis, not taken on
faith; see the "Correction" callouts.**

### Step 2 — "no active requester session" → requester-agent handoff fallback

- `src/agents/subagents/announce/subagent-announce-direct-delivery.ts:343-348` logs
  exactly `"...falling back to requester-agent handoff"` when
  `resolveActiveWakeWithRetries` (`subagent-announce-active-wake.ts:54-61`) finds no
  active run to steer the completion into.
- Mechanism: because the main agent's reply turn had already ended before the worker's
  8 completions arrived, there was no active run to steer into, so each completion fell
  through to a **brand-new** dispatch through the Gateway's in-process `"agent"` method
  (`dispatchSubagentAnnounceAgent` → `dispatchGatewayMethodInProcess("agent", ...)`,
  `subagent-announce-delivery.runtime.ts:174-178`, called from
  `subagent-announce-completion-delivery.ts:80-119`) instead of continuing the existing
  conversation.
- **Present in 2026.9.6:** yes, as above. **Present in 2026.7.1-2:** yes, essentially
  identical in the old monolithic `src/agents/subagent-announce-delivery.ts`.
  **Not a regression** — this fallback design predates production.
- **This Gateway `"agent"` in-process dispatch is a distinct code path from the
  `auto-reply` layer** (`src/auto-reply/reply/agent-runner-cli-candidate.ts` /
  `agent-runner-fallback-candidate.ts`, which only handles *live inbound channel
  messages*, not internal completion hand-offs — confirmed by grepping every caller of
  `runCliFallbackCandidate`: only `agent-runner-fallback-candidate.ts` calls it).
  This distinction matters for point 3 below.

### Step 3 — session churn on every completion hand-off

**Correction:** the original version of this analysis said the `messageToolPolicyHash`
mismatch (`"reuse=invalidated:message-policy"`) was unfixed and identical on both
versions. That's wrong for 2026.9.6. Re-verified directly against this source tree:

- The mismatch is real on **`v2026.7.1-2`**: `src/agents/cli-session.ts` (old tag,
  `:178-181`) invalidates reuse when the turn's `messageToolPolicyHash` differs from
  the stored binding's, computed in `prepare.ts` as
  `sha256(JSON.stringify({sourceReplyDeliveryMode, requireExplicitMessageTarget}))`
  (`JSON.stringify` drops `undefined` keys). An ordinary DM turn hashes
  `{"sourceReplyDeliveryMode":"automatic","requireExplicitMessageTarget":false}`; a
  completion hand-off turn (subagent completion or `image_generate`) hashes a
  differently-shaped object (`"message_tool_only"`, or `requireExplicitMessageTarget`
  alone) — every hand-off invalidates reuse.
- **On current `main`/`2026.9.6` this is fixed.** `src/agents/command/prepare.ts:314-330`
  calls `isSyntheticSourceReplyTurn({ inputProvenance, isHeartbeat })`
  (`src/agents/reply-completion.ts:23-32` — true for `inputProvenance.kind ===
  "inter_session"`, which is exactly what an `image_generate`/subagent completion
  hand-off carries) and, when true, computes `cliSessionBindingFacts.sourceReplyDeliveryMode`
  via `resolveSessionStableReplyMode(...)` — **the same session-stable-mode resolution
  an ordinary dispatch turn uses** — instead of letting the hand-off's own ad-hoc
  request mode leak into the hash. I confirmed this directly (not just from the
  parallel analysis): both `isSyntheticSourceReplyTurn` and the
  `resolveSessionStableReplyMode` call site exist exactly as described in this checked-out
  tree. This closes the hash-split for completion hand-offs.
- **What is *not* fixed, and is the actual remaining defect on 2026.9.6:** even with a
  matching hash, a completion hand-off turn's *newly created* CLI session id is never
  persisted back into the session store, because of a **separate** suppression
  mechanism from the one this analysis originally (and only partially correctly)
  attributed to `sparx/fix-4-synthetic-client-completion` (PR #3):
  - The real hand-off path (Gateway `"agent"` method → `agent-command.ts` →
    `run-embedded-attempt.ts`) sets, at `src/gateway/agent-turn/agent-request-preflight.ts:376-378`:
    ```ts
    preserveUserFacingSessionModelState:
      canUseInternalRuntimeHandoff &&
      shouldPreserveUserFacingSessionStateForInputProvenance(inputProvenance),
    ```
    which — confirmed directly — flows into
    `src/agents/command/run-embedded-attempt.ts:487-489`:
    ```ts
    preserveCliSessionBinding:
      isHeartbeatLifecycleRunKind(logicalTurnOpts.bootstrapContextRunKind) ||
      params.preserveUserFacingSessionModelState,
    ```
    and `preserveCliSessionBinding` is exactly the flag `src/agents/command/attempt-execution.ts:840`
    checks before persisting the new binding — when true, persistence is skipped.
  - This is a **different file and mechanism** than what PR #3 (`sparx/fix-4-synthetic-client-completion`)
    changed (`src/auto-reply/reply/agent-runner-cli-candidate.ts`, part of the
    *auto-reply/live-channel-message* path per point 2's distinction above, not the
    completion-hand-off path). **PR #3 is a real, independently useful fix for its own
    path (a live channel turn following an `image_generate` result can otherwise resume
    a stale pre-completion session), but it does not fix the mechanism that actually ran
    during this incident's completion hand-offs.** The hand-off path's equivalent
    suppression, at `run-embedded-attempt.ts:487-489`, remains unfixed on 2026.9.6.
  - **This is deliberately left as an open design question, not a same-day code fix.**
    The suppression is pinned generically (not `image_generate`-specifically) by
    `src/agents/command/attempt-execution.cli.test.ts`'s parameterized
    `"settles a cold %s CLI binding before the next queued command starts"` test, whose
    `"preserved-state"` case exists because an upstream commit
    (`c103dbc94f2`/#136644 per the parallel analysis, not independently re-verified by
    this file) intentionally made *all* `preserveUserFacingSessionModelState` turns
    retain the prior binding, not just heartbeats. A blanket carve-out for
    media-generation tools (mirroring PR #3's approach) risks a **new** failure mode
    this incident's own shape would trigger: 8 near-simultaneous completions each
    persisting a *different* new binding could race/thrash the stored binding under
    concurrent delivery, which the current "always keep the prior, stable binding"
    design avoids by construction. A correct fix needs the hand-off's own reuse outcome
    exposed to the persistence decision (e.g. "only persist if *this* turn actually
    resumed the existing binding, never if it started fresh") — a design change, not a
    minimal patch, so no PR was opened for it here. Flagging for a maintainer decision.

### Step 4 — duplicate media/apology re-attachment

Same root cause as point 3's remaining gap: because a completion hand-off's new CLI
session is never persisted, every hand-off after the first replays the full,
growing conversation transcript from scratch and regenerates a reply that re-attaches
every image already visible in it, plus a fresh apology. No separate re-delivery/dedupe
mechanism causes this and none was found to bolt on without materially widening scope.
Fixing point 3's remaining gap (once a safe design exists) fixes this too.

### Step 5 — announce/completion delivery retry never terminates (confirmed regression, two independent contributing defects)

Two independent retry mechanisms are involved:

1. **Bounded per-call retry** (the literal "retrying n/4" log):
   `src/agents/subagents/announce/subagent-announce-delivery-retry.ts`,
   `runAnnounceDeliveryWithRetry` (lines 231-269), delays `[5_000, 10_000, 20_000]`ms,
   log at line 257. This counter is local to one call and cannot itself restart from a
   lower number.
2. **Regression A — the retry-count ceiling was deleted (fixed here, PR #6).**
   `src/agents/subagents/registry/subagent-registry-cleanup.ts:54-97`
   (`resolveDeferredCleanupDecision`): on 2026.9.6 the only give-up conditions were
   `disposition === "permanent_failure"` or a **time-based**
   `ANNOUNCE_COMPLETION_HARD_EXPIRY_MS = 30 * 60_000` — no retry-count cap. On
   `v2026.7.1-2`, the equivalent function gave up with `reason: "retry-limit"` once
   `retryCount >= maxAnnounceRetryCount`, fed by `MAX_ANNOUNCE_RETRY_COUNT = 3`
   (`src/agents/subagent-registry-helpers.ts:44` in that tag — **independently
   re-verified against the fetched tag for this note**). Separately,
   `src/agents/subagents/completion/subagent-completion-delivery.ts:78-124`
   (`admitCorrelatedSubagentSessionDelivery`), a **new-in-2026.9.6** durable
   session-delivery-queue redrive path with no `v2026.7.1-2` equivalent, set
   `maxRetries: Number.MAX_SAFE_INTEGER`, bypassing the generic
   `MAX_SESSION_DELIVERY_RETRIES = 5` cap every other queue owner gets. **Fixed in
   `sparx/fix-5-announce-retry-limit` (PR #6)**, which restores
   `MAX_ANNOUNCE_RETRY_COUNT = 3` and removes the `Number.MAX_SAFE_INTEGER` override.
3. **Regression B — quota/billing/auth exhaustion is misclassified as transient (found
   by the parallel Opus analysis, independently opened as PR #4, not duplicated here).**
   `isTransientFailoverAnnounceError` (`subagent-announce-delivery-retry.ts`) treated
   **any** fallback-exhausted `FailoverError` (`attempts.length > 0`) as transient,
   including cases where every fallback candidate failed on `billing` (quota
   exhaustion, exactly what happened at 21:53:59), `auth_permanent`, or
   `model_not_found` — none of which will ever resolve by retrying. Each retry replays
   a full requester turn. Fixed in `sparx/opus-fix-5-announce-billing-retry` (PR #4):
   retry only when at least one fallback candidate failed for a reason
   `shouldUseTransientCooldownProbeSlot` (`src/agents/failover-policy.ts`) already
   classifies as transient (rate limit, overloaded, timeout, unclassified).
- **Net effect:** on 2026.9.6, without both PR #6 and PR #4, a stuck `image_generate`
  completion delivery — including one stuck specifically *because* the provider quota
  ran out — retries with no attempt-count ceiling and no exhaustion-reason check, for up
  to 30 minutes, and every retry is a fresh, transcript-replaying CLI turn (point 3) —
  this is the compounding mechanism that burned the provider quota and kept retrying
  *after* it was already exhausted.
- **Verdict: two independent regressions, both meaningfully worse on 2026.9.6 than
  2026.7.1-2, both fixed (PR #6, PR #4).**

### Step 6 — "CLI session cleared after failed reused turn"

**Correction:** the original version of this analysis focused on a scoping gap in the
"don't clear while media is pending" guard and called it the root cause on both
versions. Re-verified directly: that gap is real (§ below, PR #2), but it is **not**
what actually cleared the binding during the incident, which ran on **production**
(`2026.7.1-2`) — a much blunter, unconditional bug did that there, and it is already
fixed upstream by the time of `2026.9.6`.

- **`v2026.7.1-2` (production, what actually happened):**
  `agents/command/attempt-execution.ts:776-796` (old tag) clears the stored CLI binding
  whenever `shouldClearReusedCliSessionAfterError` is true, which covers **any**
  `FailoverError` (rate_limit, billing, timeout, …) or any `AbortError` — the only
  condition is that a binding *exists*, not that this turn resumed it. Because the
  completion hand-off had `useResume=false` (point 3), it failed on quota exhaustion in
  a *different, freshly-started* session and still deleted the *main* binding anyway.
  The log text "failed reused turn" is misleading here — this turn never resumed
  anything. This is the actual step-6 mechanism in the incident.
- **`v2026.9.6`: this exact unconditional-clear bug is already fixed upstream**, before
  any of this incident's fixes. `src/agents/cli-session.ts:156-176`
  (`shouldClearFailedCliSessionBinding`) now clears only for failover reason
  `session_expired`, or an `AbortError` whose binding was replaced mid-run — not for an
  arbitrary quota/rate-limit/timeout failure on an unrelated fresh session. (Per the
  parallel analysis this landed in commit `e2deb87c305`/#128732; not independently
  re-derived by this file beyond confirming the current guard's narrower shape
  matches.)
- **A separate, narrower, still-real gap remains in 2026.9.6's already-narrowed guard,
  fixed here (PR #2):** the guard's one protective exception — don't clear while
  `hasNewGeneratedMediaTask === true` ("Detached media delivers back into this run
  later and still needs the binding") — silently could never engage for an ordinary,
  non-cron channel session (like this incident's LINE WORKS DM), because
  `getGeneratedMediaTaskIdsForSessionKey` (`src/tasks/task-status-access.ts:63-73`)
  unconditionally returned an empty set unless the session key was
  cron-run-scoped (`parseCronRunScopeSuffix(...).runId`). Fixed in
  `sparx/fix-5-preserve-cli-binding` (PR #2) by adding
  `getGeneratedMediaTaskIdsForAnySessionKey`/`hasNewGeneratedMediaTaskForAnySessionKey`
  for the two clearly-generic, non-cron-specific callers
  (`attempt-execution.ts`, `agent-runner-cli-candidate.ts`). **This gap is real and
  worth fixing, but — given the correction above — it is a secondary, narrower
  protection layer within 2026.9.6's already-much-improved guard, not the mechanism
  that actually caused the production incident's binding to be cleared** (that was the
  blunter 7.1-2 bug, already fixed upstream independent of anything in this file).

### `sessions_spawn` / completion routing (context, not a separate bug)

Entry point `src/agents/subagents/spawn/subagent-spawn.ts` /
`subagent-spawn-request.ts` (enforces `maxSpawnDepth`/`maxChildrenPerAgent`, §C).
**Unverified, inference only** (per the parallel analysis, not independently checked
here): `image_generate` records the *calling* session as the media requester, so the
worker's own repeated image completions (the same image generated 3× and another 2×,
11 total) may have run inside the *worker's own* session and been subject to the same
reseed/churn mechanism recursively — the worker's transcript was not available to
confirm this.

---

## B. Fixes

Four PRs into `SPARX-CS/openclaw` `main`, based on `origin/main` (`8eed7e85`):

- **PR #2 — `sparx/fix-5-preserve-cli-binding`.** Widens the media-pending protective
  guard (step 6) to non-cron session keys. Real, tested fix; narrower impact than
  originally stated — see the step-6 correction above.
- **PR #3 — `sparx/fix-4-synthetic-client-completion`** (found already pushed by the
  sibling `openclaw-upgrade-check` routine; verified and PR opened here per the task
  brief's "build on it, don't duplicate" instruction). Real, tested, independently
  useful fix for the *auto-reply/live-channel* CLI-candidate path — **not** the path
  this incident's completion hand-offs actually ran through; see the step-3 correction
  above for where the equivalent, still-open gap actually lives.
- **PR #4 — `sparx/opus-fix-5-announce-billing-retry`** (opened by the parallel Opus
  investigation, not duplicated here). Stops quota/auth/model-exhaustion failures from
  being retried as if transient.
- **PR #6 — `sparx/fix-5-announce-retry-limit`.** Restores an attempt-count ceiling for
  the announce/completion delivery redrive.

**Note:** PR #2 and PR #3 both touch `src/auto-reply/reply/agent-runner-cli-candidate.ts`
in adjacent-but-non-overlapping spots (different import renames two lines apart, plus
separate call sites); whichever merges second will need a small, mechanical
import-block conflict resolved — flagged in PR #3's body.

**Scoped out of this pass (documented, not code-changed):**

- **Persisting a completion hand-off's new CLI session on the real hand-off path
  (the corrected step 3 finding above).** Needs a design change (persist only when the
  turn actually resumed the existing binding, never when it started fresh) to avoid a
  new binding-thrash risk under concurrent completions — exactly this incident's
  shape. Flagged for a maintainer decision, not attempted as a same-day patch.
- **A completion must not re-deliver media already delivered (point 4).** Confirmed not
  a distinct, separately-fixable mechanism: the duplicate images/apologies are freshly
  generated by each new CLI session replaying the reseeded transcript, not resent from a
  stored "already sent" record — there's no existing dedupe layer to extend, and
  building one would mean adding new cross-cutting state to every outbound send path.
  Fixing the point-3 design gap fixes this too, once that lands.

---

## Recommendation

Upgrade to `2026.9.6`+ once PR #2, #3, #4, and #6 land — 2026.9.6 already fixes the
message-policy hash-split (step 3's original trigger) and the unconditional
clear-on-any-`FailoverError` bug (step 6's actual production mechanism) upstream,
*before* any of this incident's fixes; without PR #4 and #6, though, its retry
regression (step 5) is strictly worse than `2026.7.1-2`'s. Apply the §C `tools.deny` or
`maxConcurrent` reduction on production today regardless of version or upgrade timing;
it's the only same-day lever available. The step-3 design gap (completions never
persisting a fresh CLI binding) remains open on 2026.9.6 even after all four PRs land —
raise it with the team as a design question before attempting a patch.
