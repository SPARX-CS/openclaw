// Support for f4-quota-exhausted-turn.test.ts (works on tree A = 2026.9.6+patches and B = 2026.9.7).
//
// The test file MUST do this before importing this file (same pattern as
// src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts):
//   await vi.hoisted(async () => {
//     await import("../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js");
//   });
// That registers the mocks (model fallback runner, CLI runner entry, follow-up queue, ...).
// Nothing here touches the network, a real `claude` binary, or a real key.
import path from "node:path";
import { vi } from "vitest";
import { parseCliOutput } from "../../src/agents/cli-output.js";
import { createCliOutputFailoverError } from "../../src/agents/cli-runner/output-error.js";
import type { FailoverError } from "../../src/agents/failover-error.js";
import { rootDir } from "../../src/auto-reply/reply/agent-runner.misc.runreplyagent.test-support.js";
import {
  createTestQueueSettings,
  createTestQueuedFollowupRun,
  createTestTemplateContext,
} from "../../src/auto-reply/reply/agent-runner.test-fixtures.js";
import { createMockTypingController } from "../../src/auto-reply/reply/test-helpers.js";

const { runReplyAgent } = await import("../../src/auto-reply/reply/agent-runner.js");

export const CLI_PROVIDER = "claude-cli";
export const CLI_MODEL = "opus-4.5";

/** Texts the Claude CLI prints when the subscription quota is gone (UTC so the test is timezone-proof). */
export const SESSION_LIMIT_TEXT = "You've hit your session limit · resets 3pm (UTC)";
export const WEEKLY_LIMIT_TEXT = "You've hit your weekly limit · resets 6pm (UTC)";
export const BARE_LIMIT_TEXT = "You’ve hit your limit · resets 3pm (UTC)";
export const HTTP_429_TEXT =
  'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}';

/**
 * Claude `--output-format stream-json` where the run ends with an `is_error` result carrying the
 * notice (same shape as src/agents/test-helpers/claude-api-error-fixture.ts).
 */
export function claudeErrorStreamJson(notice: string, sessionId = "session-quota"): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
    JSON.stringify({
      type: "assistant",
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: notice }],
      },
      session_id: sessionId,
      error: "rate_limit",
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: notice,
      session_id: sessionId,
    }),
  ].join("\n");
}

/**
 * The error the real CLI runner throws for such a run: stream-json -> parseCliOutput ->
 * createCliOutputFailoverError (agents/cli-runner/output-error.ts, classifyFailoverReason inside).
 */
export function claudeCliLimitError(notice: string): FailoverError {
  const output = parseCliOutput({
    raw: claudeErrorStreamJson(notice),
    backend: {
      command: "claude",
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      sessionIdFields: ["session_id"],
    } as never,
    providerId: CLI_PROVIDER,
    outputMode: "jsonl",
  });
  const error = createCliOutputFailoverError({ output, provider: CLI_PROVIDER, model: CLI_MODEL });
  if (!error) {
    throw new Error("expected the Claude stream-json error result to produce a failover error");
  }
  return error;
}

/** A successful CLI turn result, shaped like cli-runner's return value. */
export function cliSuccess(text: string) {
  return {
    payloads: [{ text }],
    meta: { agentMeta: { provider: CLI_PROVIDER, model: CLI_MODEL } },
  };
}

/** One user request on a claude-cli backed agent, run through the production reply layer. */
export function createClaudeCliRun(chatContext?: {
  Provider: string;
  ChatType?: "direct" | "group";
}) {
  const typing = createMockTypingController();
  const sessionCtx = createTestTemplateContext({
    Provider: chatContext?.Provider ?? "telegram",
    ...(chatContext?.ChatType ? { ChatType: chatContext.ChatType } : {}),
    MessageSid: "msg",
  });
  const followupRun = createTestQueuedFollowupRun({
    prompt: "please summarize the report",
    summaryLine: "please summarize the report",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "telegram",
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: {},
      provider: CLI_PROVIDER,
      model: CLI_MODEL,
      thinkingCatalog: [{ provider: CLI_PROVIDER, id: CLI_MODEL, input: ["text", "image"] }],
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  });
  const params = {
    commandBody: "please summarize the report",
    followupRun,
    queueKey: "main",
    resolvedQueue: createTestQueueSettings({ mode: "interrupt" }),
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing,
    sessionCtx,
    defaultModel: `${CLI_PROVIDER}/${CLI_MODEL}`,
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  } satisfies Parameters<typeof runReplyAgent>[0];
  return { run: () => runReplyAgent(params), typing };
}

/** The reply layer returns one payload or a list; the user-visible text is the first text. */
export function firstText(result: unknown): string | undefined {
  const payload = Array.isArray(result) ? result[0] : result;
  const text = (payload as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

export function allTexts(result: unknown): string[] {
  const payloads = Array.isArray(result) ? result : result ? [result] : [];
  return payloads
    .map((payload) => (payload as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string");
}

/**
 * What the reply layer receives when a fallback chain of two claude-cli models (same subscription,
 * so both hit the same limit) is exhausted: built with the production helpers
 * appendFailedCandidateAttempt + throwFallbackFailureSummary (model-fallback-attempt.ts), so the
 * attempt reasons are whatever this tree's classifier produced for each candidate error.
 */
export async function fallbackChainExhaustedError(notice: string): Promise<Error> {
  // The reply-layer harness mocks this module; the real helpers are what production uses.
  const actual = await vi.importActual<typeof import("../../src/agents/model-fallback-attempt.js")>(
    "../../src/agents/model-fallback-attempt.js",
  );
  const candidates = [
    { provider: CLI_PROVIDER, model: CLI_MODEL },
    { provider: CLI_PROVIDER, model: "sonnet-4.5" },
  ];
  const attempts: Parameters<typeof actual.appendFailedCandidateAttempt>[0]["attempts"] = [];
  let lastError: unknown;
  for (const candidate of candidates) {
    lastError = claudeCliLimitError(notice);
    actual.appendFailedCandidateAttempt({ attempts, candidate, error: lastError });
  }
  try {
    actual.throwFallbackFailureSummary({
      attempts,
      candidates,
      lastError,
      label: "models",
      formatAttempt: (attempt) =>
        `${attempt.provider}/${attempt.model}: ${attempt.error} (${attempt.reason ?? "unknown"})`,
    });
  } catch (error) {
    return error as Error;
  }
  throw new Error("throwFallbackFailureSummary did not throw");
}
