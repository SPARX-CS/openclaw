import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import type { FailoverReason } from "../../failover/signal.js";
import { runAnnounceDeliveryWithRetry } from "./subagent-announce-delivery-retry.js";

function exhaustedFallbackError(reasons: FailoverReason[]): FailoverError {
  const attempts = reasons.map((reason, index) => ({
    provider: "claude-cli",
    model: `model-${index}`,
    reason,
    error: `${reason} failure`,
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

  it("retries when a fallback candidate failed transiently", async () => {
    const error = exhaustedFallbackError(["billing", "overloaded"]);
    const { run, rejection } = await runWithRejection(error);

    expect(rejection).toBe(error);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
