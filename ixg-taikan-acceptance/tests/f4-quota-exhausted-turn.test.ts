// F4: the Claude subscription quota runs out in the middle of a turn (Claude CLI "session limit"
// notice, or HTTP 429) while the bot (claude-cli backend) is handling a user request.
// In production the request ended as a failure; when the quota came back nothing continued; the
// user at best got "please send again".
//
// Desired behavior asserted below (a version that does not meet it FAILs = a "not passing" row):
//   (1) when the quota is exhausted the user gets a short plain-language notice, and the notice is
//       accurate about WHEN it can work again if it says so;
//   (2) when the quota returns, the stopped request is continued automatically and the real
//       content is returned (a bundled retry/resume mechanism is fine; none is required to be a
//       specific one).
// `(record)` rows pin the current behavior and pass on the version they describe.
//
// Seam: the production reply layer `runReplyAgent` (src/auto-reply/reply/agent-runner.ts) with the
// existing mock harness of agent-runner.misc.runreplyagent.test-support.ts (identical in A and B).
// The CLI runner entry (`runCliAgent`) is mocked and made to fail with the error the real CLI runner
// builds from a Claude stream-json `is_error` result (parseCliOutput -> createCliOutputFailoverError,
// which includes classifyFailoverReason). No real `claude` process, no network, no key.
// Clock: 2026-10-05 13:00 UTC; the notice says "resets 3pm (UTC)", i.e. the quota returns in 2 h.
import { describe, expect, it, vi } from "vitest";

// Register the harness mocks before the runner (and the support file) are imported.
await vi.hoisted(async () => {
  await import("../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js");
});

import { classifyFailoverReason } from "../../src/agents/embedded-agent-helpers.js";
import { FailoverError } from "../../src/agents/failover-error.js";
import {
  runCliAgentMock,
  setupAgentRunnerTestHooks,
} from "../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js";
import { enqueueFollowupRun } from "../../src/auto-reply/reply/queue.js";
import {
  BARE_LIMIT_TEXT,
  CLI_MODEL,
  CLI_PROVIDER,
  HTTP_429_TEXT,
  SESSION_LIMIT_TEXT,
  WEEKLY_LIMIT_TEXT,
  allTexts,
  claudeCliLimitError,
  cliSuccess,
  createClaudeCliRun,
  fallbackChainExhaustedError,
  firstText,
} from "./f4-quota-exhausted-turn.support.js";

setupAgentRunnerTestHooks();

const HOUR_MS = 3_600_000;
const NOW = new Date("2026-10-05T13:00:00Z"); // "resets 3pm (UTC)" is 2 hours away
const REAL_CONTENT = "SUMMARY: the report says revenue grew 12% quarter over quarter.";

// What counts as what in the user-visible text.
const GENERIC_FAILURE = /agent run failed|something went wrong|run failed/i;
const NAMES_A_LIMIT = /rate[- ]?limit|\blimit|\bquota|\busage\b|\b429\b/i;
const SHORT_WAIT_PROMISE = /few minutes|a moment|shortly|in a minute|couple of minutes/i;
const NAMES_RESET_TIME = /\b3\s?pm\b|\b15:00\b/i;
const ASKS_USER_TO_RETRY =
  /try again|resend|send (?:it|that|your (?:message|request)) again|retry/i;
const PROMISES_AUTO_CONTINUE =
  /automatic|continue (?:when|once|after)|resume|will (?:reply|respond|answer|continue)/i;
const MAX_NOTICE_CHARS = 300; // "short"

/** Pin only Date (so "now" is 13:00 UTC); other timers stay real and nothing can hang. */
function pinClock() {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
}

/** Run one user request whose CLI execution dies with `error`; return what the user is shown. */
async function userSeesAfter(error: unknown, chat?: Parameters<typeof createClaudeCliRun>[0]) {
  pinClock();
  runCliAgentMock.mockRejectedValueOnce(error);
  const result = await createClaudeCliRun(chat).run();
  return { result, text: firstText(result) ?? "" };
}

describe("F4.1 quota exhausted -> short plain notice (not a generic failure)", () => {
  it.each([
    ["direct chat", { Provider: "telegram", ChatType: "direct" as const }],
    ["group chat", { Provider: "telegram", ChatType: "group" as const }],
  ])(
    "F4.1 session-limit notice from the Claude CLI -> short plain limit notice, not 'agent run failed' (%s)",
    async (_label, chat) => {
      const { text } = await userSeesAfter(claudeCliLimitError(SESSION_LIMIT_TEXT), chat);
      expect(text, "notice shown to the user").not.toMatch(GENERIC_FAILURE);
      expect(text, "notice shown to the user").toMatch(NAMES_A_LIMIT);
      expect(text.length, "notice length").toBeLessThanOrEqual(MAX_NOTICE_CHARS);
    },
  );

  it("F4.1b same, when the fallback chain (2 models of the same subscription) is exhausted", async () => {
    const { text } = await userSeesAfter(await fallbackChainExhaustedError(SESSION_LIMIT_TEXT));
    expect(text, "notice shown to the user").not.toMatch(GENERIC_FAILURE);
    expect(text, "notice shown to the user").toMatch(NAMES_A_LIMIT);
    expect(text.length, "notice length").toBeLessThanOrEqual(MAX_NOTICE_CHARS);
  });
});

describe("F4.2 the notice is accurate about when it can work again", () => {
  it("F4.2 reset 2 h away: the notice names the reset time, or at least does not promise a minutes-scale wait (and still says it is a limit)", async () => {
    const { text } = await userSeesAfter(claudeCliLimitError(SESSION_LIMIT_TEXT));
    const tellsReset = NAMES_RESET_TIME.test(text);
    const noWrongPromise = NAMES_A_LIMIT.test(text) && !SHORT_WAIT_PROMISE.test(text);
    expect(tellsReset || noWrongPromise, `notice shown to the user: ${JSON.stringify(text)}`).toBe(
      true,
    );
  });

  it("F4.2b stricter: the notice states the reset time given by the CLI (3pm UTC)", async () => {
    const { text } = await userSeesAfter(claudeCliLimitError(SESSION_LIMIT_TEXT));
    expect(text, "notice shown to the user").toMatch(NAMES_RESET_TIME);
  });
});

describe("F4.3 / F4.4 comparison rows (expected to meet the desired behavior)", () => {
  it("F4.3 weekly-limit notice ('weekly limit · resets 6pm') names the reset and promises no short wait", async () => {
    const { text } = await userSeesAfter(claudeCliLimitError(WEEKLY_LIMIT_TEXT));
    expect(text, "notice shown to the user").toMatch(/\b6\s?pm\b|\b18:00\b/i);
    expect(text, "notice shown to the user").not.toMatch(SHORT_WAIT_PROMISE);
  });

  it.each([
    ["CLI-surfaced 'API Error: 429 {rate_limit_error}'", () => claudeCliLimitError(HTTP_429_TEXT)],
    [
      "plain Error carrying HTTP status 429 (nothing classified yet)",
      () => Object.assign(new Error("Request failed with status code 429"), { status: 429 }),
    ],
    [
      "bare HTTP 429 failover error (no provider text)",
      () =>
        new FailoverError("429 Too Many Requests", {
          reason: "rate_limit",
          provider: CLI_PROVIDER,
          model: CLI_MODEL,
          status: 429,
        }),
    ],
  ])("F4.4 HTTP 429 from the provider -> plain notice: %s", async (_label, makeError) => {
    const { text } = await userSeesAfter(makeError());
    expect(text, "notice shown to the user").not.toMatch(GENERIC_FAILURE);
    expect(text, "notice shown to the user").toMatch(NAMES_A_LIMIT);
    expect(text.length, "notice length").toBeLessThanOrEqual(MAX_NOTICE_CHARS);
  });
});

describe("F4.5 continuation after the quota returns", () => {
  it("F4.5 after the reset (clock +2h30m) the stopped request is continued automatically; the user does not re-send", async () => {
    vi.useFakeTimers({ now: NOW });
    runCliAgentMock
      .mockRejectedValueOnce(claudeCliLimitError(SESSION_LIMIT_TEXT))
      .mockResolvedValue(cliSuccess(REAL_CONTENT));

    const first = await createClaudeCliRun().run(); // the user is shown the quota notice
    expect(allTexts(first), "first reply is the quota notice, not content").not.toContain(
      REAL_CONTENT,
    );

    await vi.advanceTimersByTimeAsync(2.5 * HOUR_MS); // reset at 15:00 UTC -> 15:30 UTC

    // "Continued" = the same request is executed again (CLI runner called a 2nd time with the
    // original prompt) or re-submitted through the follow-up queue. The user sent nothing.
    const cliPrompts = runCliAgentMock.mock.calls.map(
      (call) => (call[0] as { prompt?: string } | undefined)?.prompt ?? "",
    );
    const requeued = vi
      .mocked(enqueueFollowupRun)
      .mock.calls.some((call) => JSON.stringify(call).includes("summarize the report"));
    const reExecuted = cliPrompts.length >= 2 && cliPrompts[1].includes("summarize the report");
    expect(
      reExecuted || requeued,
      `CLI executions=${cliPrompts.length} (1 = nothing re-ran), follow-up re-enqueues=${
        vi.mocked(enqueueFollowupRun).mock.calls.length
      }, pending timers=${vi.getTimerCount()}`,
    ).toBe(true);
  });

  it("F4.5b (record) nothing is scheduled after the notice: no timer, no re-enqueue, no 2nd execution even 6 h later", async () => {
    vi.useFakeTimers({ now: NOW });
    runCliAgentMock
      .mockRejectedValueOnce(claudeCliLimitError(SESSION_LIMIT_TEXT))
      .mockResolvedValue(cliSuccess(REAL_CONTENT));

    const first = await createClaudeCliRun().run();
    // Evidence that no scheduler exists at this layer: right after the failure there is no pending
    // timer and nothing was put on the follow-up queue.
    expect(vi.getTimerCount(), "pending timers right after the failure").toBe(0);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6 * HOUR_MS); // far past the 3pm reset
    expect(runCliAgentMock, "CLI executions 6 h later").toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(allTexts(first), "the user only ever got the notice").toHaveLength(1);
  });
});

describe("F4.6 the 'please send again' notice", () => {
  it("F4.6 (record) wording on this tree: A = rate-limited copy that asks to try again; B = bare 'Agent run failed'; neither promises auto-continue", async () => {
    const { text } = await userSeesAfter(claudeCliLimitError(SESSION_LIMIT_TEXT));
    const known = [
      // A (patch 0006 classifies it as rate_limit): renderRateLimitReplyCopy single-candidate copy.
      { copy: /rate-limited.*try again in a few minutes/i, asksToRetry: true },
      // B (reason 'unknown'): assistant-request-failure copy.
      { copy: /agent run failed \(model: [^)]+\)/i, asksToRetry: false },
    ].find((entry) => entry.copy.test(text));
    expect(known, `unrecognised copy (the record changed): ${JSON.stringify(text)}`).toBeDefined();
    expect(ASKS_USER_TO_RETRY.test(text)).toBe(known?.asksToRetry);
    expect(text).not.toMatch(PROMISES_AUTO_CONTINUE);
  });
});

describe("F4.7 classification of the strings the Claude CLI / provider emit", () => {
  it.each([
    ["'session limit · resets 3pm' (needs patch 0006 in A; absent in B)", SESSION_LIMIT_TEXT],
    ["bare 'limit · resets 3pm' with a curly apostrophe (same)", BARE_LIMIT_TEXT],
    ["'weekly limit · resets 6pm' (periodic rule, both)", WEEKLY_LIMIT_TEXT],
    ["HTTP 429 rate_limit_error (both)", HTTP_429_TEXT],
  ])("F4.7 %s -> rate_limit (status 429)", (_label, notice) => {
    expect(
      classifyFailoverReason(notice, { provider: CLI_PROVIDER }),
      "classifyFailoverReason",
    ).toBe("rate_limit");
    const error = claudeCliLimitError(notice); // stream-json is_error -> createCliOutputFailoverError
    expect(error.reason, "FailoverError.reason").toBe("rate_limit");
    expect(error.status, "FailoverError.status").toBe(429);
  });
});
