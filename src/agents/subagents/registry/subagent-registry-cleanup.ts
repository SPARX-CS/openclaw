/**
 * Subagent registry cleanup decisions.
 *
 * Decides whether completed runs can be cleaned up, deferred for descendants, retried, or abandoned.
 */
import { getDeliveryAttemptCount } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { MAX_ANNOUNCE_RETRY_COUNT } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const shouldSuspendPendingFinalDelivery = (entry: SubagentRunRecord) =>
  entry.expectsCompletionMessage === true &&
  entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE &&
  entry.execution.outcome?.status === "ok";

type DeferredCleanupDecision =
  | {
      kind: "defer-descendants";
      delayMs: number;
    }
  | {
      kind: "give-up";
      reason: "expiry" | "permanent_failure" | "retry-limit";
      retryCount?: number;
    }
  | {
      kind: "retry";
      retryCount: number;
      resumeDelayMs?: number;
    };

/** Resolve the lifecycle ended reason used when cleaning up a subagent run. */
export function resolveCleanupCompletionReason(
  entry: SubagentRunRecord,
): SubagentLifecycleEndedReason {
  return entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
}

/** Required-delivery retries renew their window; optional delivery expires from completion. */
export function resolveAnnounceDeliveryDeadline(
  entry: SubagentRunRecord,
  now: number,
  expiryMs: number,
): number {
  const delivery = entry.expectsCompletionMessage === true ? entry.delivery : undefined;
  return (
    delivery?.deadlineAt ?? (delivery?.windowStartedAt ?? entry.execution.endedAt ?? now) + expiryMs
  );
}

/** Decide whether deferred subagent cleanup should retry, defer, or give up. */
export function resolveDeferredCleanupDecision(params: {
  entry: SubagentRunRecord;
  now: number;
  activeDescendantRuns: number;
  announceExpiryMs: number;
  announceCompletionHardExpiryMs: number;
  deferDescendantDelayMs: number;
  resolveAnnounceRetryDelayMs: (retryCount: number) => number;
  /**
   * The pending requester still owns this delivery; the caller only observed
   * that fact and did not spend a real delivery attempt. Exempt from the
   * retry-count ceiling so a busy but healthy requester cannot look like a
   * stuck delivery; the expiry/permanent-failure give-up checks still apply.
   */
  isRequesterTurnObservation?: boolean;
}): DeferredCleanupDecision {
  const isCompletionMessageFlow = params.entry.expectsCompletionMessage === true;
  const expiryMs = isCompletionMessageFlow
    ? params.announceCompletionHardExpiryMs
    : params.announceExpiryMs;
  const expiryExceeded =
    params.now >= resolveAnnounceDeliveryDeadline(params.entry, params.now, expiryMs);
  if (isCompletionMessageFlow && params.activeDescendantRuns > 0) {
    if (expiryExceeded) {
      return { kind: "give-up", reason: "expiry" };
    }
    return { kind: "defer-descendants", delayMs: params.deferDescendantDelayMs };
  }

  const retryCount = getDeliveryAttemptCount(params.entry) + 1;
  if (params.entry.delivery?.disposition === "permanent_failure" || expiryExceeded) {
    return {
      kind: "give-up",
      reason:
        params.entry.delivery?.disposition === "permanent_failure" ? "permanent_failure" : "expiry",
      retryCount,
    };
  }

  if (!params.isRequesterTurnObservation && retryCount > MAX_ANNOUNCE_RETRY_COUNT) {
    // Each retry mints a fresh CLI session and replays the full transcript;
    // an attempt-count ceiling bounds that cost even while the time-boxed
    // delivery window has not yet expired.
    return { kind: "give-up", reason: "retry-limit", retryCount };
  }

  const persistedNextAttemptAt = params.entry.delivery?.nextAttemptAt;
  const nextAttemptAt =
    typeof persistedNextAttemptAt === "number" && persistedNextAttemptAt > params.now
      ? persistedNextAttemptAt
      : params.now + params.resolveAnnounceRetryDelayMs(retryCount);

  return {
    kind: "retry",
    retryCount,
    resumeDelayMs: nextAttemptAt - params.now,
  };
}
