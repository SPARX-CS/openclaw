import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliOutputFailoverError } from "../../cli-runner/output-error.js";
import { FailoverError } from "../../failover-error.js";
import type { FailoverReason } from "../../failover/signal.js";
import { runAnnounceDeliveryWithRetry } from "./subagent-announce-delivery-retry.js";

function exhaustedFallbackError(reasons: FailoverReason[], message?: string): FailoverError {
  const attempts = reasons.map((reason, index) => ({
    provider: "claude-cli",
    model: `model-${index}`,
    reason,
    error: message ?? `${reason} failure`,
  }));
  return new FailoverError(`All models failed (${attempts.length})`, {
    reason: reasons.at(-1) ?? "unknown",
    provider: "claude-cli",
    model: attempts.at(-1)?.model,
    attempts,
  });
}

async function runWithRejection(error: unknown) {
  const run = vi.fn(async () => {
    throw error;
  });
  const outcome = runAnnounceDeliveryWithRetry({ operation: "test", run }).then(
    () => undefined,
    (err: unknown) => err,
  );
  await vi.runAllTimersAsync();
  return { run, rejection: await outcome };
}

describe("runAnnounceDeliveryWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["quota exhausted on every candidate", ["billing", "billing"]],
    ["permanent auth failure after fallback", ["auth_permanent", "model_not_found"]],
  ] satisfies Array<[string, FailoverReason[]]>)(
    "does not replay the requester turn when %s",
    async (_label, reasons) => {
      const error = exhaustedFallbackError(reasons);
      const { run, rejection } = await runWithRejection(error);

      expect(rejection).toBe(error);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("does not replay the requester turn when every candidate hit a subscription usage limit", async () => {
    const error = exhaustedFallbackError(
      ["rate_limit", "rate_limit"],
      "Claude AI usage limit reached. Your limit will reset at 11pm.",
    );
    const { run } = await runWithRejection(error);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    "You've hit your session limit · resets 3pm (Asia/Tokyo)",
    "You’ve hit your session limit · resets 3pm (Asia/Tokyo)",
    "You've hit your limit · resets 5am (UTC)",
    "You’ve hit your limit · resets 5am (UTC)",
  ])("does not replay the requester turn after claude-cli reports %s", async (errorText) => {
    const cliError = createCliOutputFailoverError({
      output: { text: "", errorText },
      provider: "claude-cli",
      model: "claude-opus",
    });
    expect(cliError?.reason).toBe("rate_limit");
    const error = exhaustedFallbackError([cliError?.reason ?? "unknown"], errorText);
    const { run } = await runWithRejection(error);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries a short-window rate limit", async () => {
    const error = exhaustedFallbackError(["rate_limit"], "429 Too Many Requests");
    const { run } = await runWithRejection(error);

    expect(run).toHaveBeenCalledTimes(4);
  });

  it("retries when a fallback candidate failed transiently", async () => {
    const error = exhaustedFallbackError(["billing", "overloaded"]);
    const { run, rejection } = await runWithRejection(error);

    expect(rejection).toBe(error);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
