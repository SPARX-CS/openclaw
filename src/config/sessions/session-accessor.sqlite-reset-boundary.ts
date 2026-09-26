import { clearSessionProgressCardForReset } from "../../session-cards/progress-card-store.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { isKnownCliHistoryBoundary, type CliHistoryBoundary } from "./cli-history-boundary.js";
import type { SessionResetBoundaryWrite } from "./session-accessor.lifecycle-types.js";
import {
  loadTranscriptEventsFromDatabase,
  loadTranscriptEventsSinceLatestReset,
} from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventsInTransaction,
  ensureTranscriptHeader,
} from "./session-accessor.sqlite-transcript-store.js";
import { readSessionTranscriptHotWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { buildSessionContinuityEntry } from "./session-continuity-record.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import { resolveResetBoundaryHeaderCwd } from "./transcript-header.js";
import type { InternalSessionEntry } from "./types.js";

function readWatermark(database: OpenClawAgentDatabase, sessionId: string) {
  const watermark = readSessionTranscriptHotWatermark(database, sessionId);
  const cold = readSessionColdTranscript(database.db, sessionId);
  return { ...watermark, maxSeq: cold?.last_seq ?? watermark.maxSeq };
}

export type SessionResetBoundaryResult = {
  /**
   * CLI history account proof extended over the runtime-written reset and
   * continuity rows. Present only when the closed window was entirely covered
   * by the previous lifecycle's known proof, so no unowned row becomes readable.
   */
  cliHistoryBoundary?: CliHistoryBoundary;
};

/** Transcript reset and prior-task retirement share the owning guarded transaction. */
export function appendSessionResetBoundary(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  previousEntry: InternalSessionEntry,
  boundary: SessionResetBoundaryWrite,
): SessionResetBoundaryResult {
  // Reset may be the first append; a headerless window cannot be read on the next turn.
  ensureTranscriptHeader(
    database,
    scope,
    resolveResetBoundaryHeaderCwd(previousEntry, boundary.cwd),
  );
  const event = buildSessionResetBoundaryEvent({
    events: loadTranscriptEventsFromDatabase(database, scope.sessionId, {
      projection: "reset-boundary",
    }),
    ...boundary,
  });
  // The continuity record is read from the window this boundary closes and commits
  // (or rolls back) with it, so a record never exists without its reset or vice versa.
  const carriesContinuity = boundary.context === "preserve-tail" && boundary.continuity === true;
  const priorProof = previousEntry.cliHistoryBoundary;
  const before = carriesContinuity ? readWatermark(database, scope.sessionId) : undefined;
  const proofCoversWindow =
    before !== undefined &&
    isKnownCliHistoryBoundary(priorProof) &&
    priorProof.sessionId === scope.sessionId &&
    priorProof.maxSeq === before.maxSeq &&
    priorProof.generation === before.generation;
  const continuity = carriesContinuity
    ? buildSessionContinuityEntry({
        loadEvents: () => loadTranscriptEventsSinceLatestReset(database, scope.sessionId),
        boundaryId: event.id,
        reason: boundary.reason,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      })
    : undefined;
  const events = continuity ? [event, continuity] : [event];
  if (appendTranscriptEventsInTransaction(database, scope, events) !== events.length) {
    throw new Error("Failed to append reset boundary for " + scope.sessionKey);
  }
  let cliHistoryBoundary: CliHistoryBoundary | undefined;
  if (proofCoversWindow) {
    const after = readWatermark(database, scope.sessionId);
    if (typeof after.generation === "string" && after.maxSeq !== null) {
      cliHistoryBoundary = {
        ...priorProof,
        generation: after.generation,
        maxSeq: after.maxSeq,
        writerRunId: `session-reset:${event.id}`,
      };
    }
  }
  if (
    boundary.context === "clear" &&
    clearSessionProgressCardForReset(database.db, scope.sessionKey)
  ) {
    const { agentId, sessionKey } = scope;
    deferOpenClawAgentPostCommitPublication(database, () => {
      emitSessionLifecycleEvent({ agentId, sessionKey, reason: "progress-card-reset" });
    });
  }
  return cliHistoryBoundary ? { cliHistoryBoundary } : {};
}

/** Appends the boundary and returns the next entry carrying any extended CLI history proof. */
export function appendSessionResetBoundaryForEntry(
  database: OpenClawAgentDatabase,
  params: {
    scope: ResolvedTranscriptScope;
    previousEntry: InternalSessionEntry;
    boundary: SessionResetBoundaryWrite;
    nextEntry: InternalSessionEntry;
  },
): InternalSessionEntry {
  const { cliHistoryBoundary } = appendSessionResetBoundary(
    database,
    params.scope,
    params.previousEntry,
    params.boundary,
  );
  // A proof only follows the same transcript identity into its next lifecycle.
  return cliHistoryBoundary && params.nextEntry.sessionId === params.previousEntry.sessionId
    ? { ...params.nextEntry, cliHistoryBoundary }
    : params.nextEntry;
}
