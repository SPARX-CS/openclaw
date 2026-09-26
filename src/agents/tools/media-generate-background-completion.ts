import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { RequiredCompletionTerminalResult } from "../../tasks/task-completion-contract.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  formatGeneratedAttachmentLines,
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { deliverSubagentAnnouncement } from "../subagents/announce/subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-completion");
// Only blocked results missed the requester; retain references instead of resending.
// Match task-summary.ts TASK_RESULT_MAX_CHARS so authorized reads keep the full payload.
const MEDIA_GENERATION_RETAINED_RESULT_MAX_CHARS = 4_000;

export type MediaGenerationTaskHandle = {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  taskLabel: string;
};

export type MediaGenerationCompletionWakeOutcome =
  | { status: "delivered" }
  | { status: "pending" }
  | { status: "permanent_failure" };

export function retainBlockedMediaReferences(
  terminalResult: RequiredCompletionTerminalResult | undefined,
  attachments: AgentGeneratedAttachment[] | undefined,
): RequiredCompletionTerminalResult | undefined {
  if (terminalResult?.terminalOutcome !== "blocked") {
    return terminalResult;
  }
  const referenceLines = formatGeneratedAttachmentLines(attachments);
  if (referenceLines.length === 0) {
    return terminalResult;
  }
  const terminalSummary = [
    terminalResult.terminalSummary,
    "Retained generated media:",
    ...referenceLines,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  return {
    ...terminalResult,
    terminalSummary: truncateUtf16Safe(terminalSummary, MEDIA_GENERATION_RETAINED_RESULT_MAX_CHARS),
  };
}

// Generated images can silently swap content (photo vs. heading, page order). The
// requester session holds the source material, so it checks the files before relaying.
const IMAGE_SOURCE_CHECK_INSTRUCTION =
  "Before relaying, open each generated image file listed in this event and compare it with the original request and the source material in this conversation (text, names, numbers, which photo or heading belongs where). If an image does not match, tell the user exactly what is wrong instead of presenting it as correct, and fix it or ask; never guess.";

function buildMediaGenerationReplyInstruction(params: {
  status: "ok" | "error";
  completionLabel: string;
  checkAgainstSource?: boolean;
}) {
  if (params.status === "ok") {
    return [
      `The ${params.completionLabel} is ready for the original chat.`,
      ...(params.checkAgainstSource ? [IMAGE_SOURCE_CHECK_INSTRUCTION] : []),
      "Follow the current visible-reply contract with a short user-facing caption and every structured generated attachment from this event.",
      "Keep internal task/session details private and do not copy the internal event text verbatim.",
    ].join(" ");
  }
  return [
    `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed for the original chat.`,
    "Follow the current visible-reply contract with a concise user-facing failure message.",
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

export async function wakeMediaGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  toolName: string;
  completionLabel: string;
}): Promise<MediaGenerationCompletionWakeOutcome> {
  if (!params.handle) {
    return { status: "delivered" };
  }
  const announceId = `${params.toolName}:${params.handle.taskId}:${params.status}`;
  const mediaUrls = Array.from(
    new Set([
      ...(params.mediaUrls ?? []),
      ...mediaUrlsFromGeneratedAttachments(params.attachments),
    ]),
  );
  const internalEvents: AgentInternalEvent[] = [
    {
      type: "task_completion",
      source: params.eventSource,
      childSessionKey: `${params.toolName}:${params.handle.taskId}`,
      childSessionId: params.handle.taskId,
      announceType: params.announceType,
      taskLabel: params.handle.taskLabel,
      status: params.status,
      statusLabel: params.statusLabel,
      result: params.result,
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      ...(mediaUrls.length ? { mediaUrls } : {}),
      ...(params.statsLine?.trim() ? { statsLine: params.statsLine } : {}),
      replyInstruction: buildMediaGenerationReplyInstruction({
        status: params.status,
        completionLabel: params.completionLabel,
        checkAgainstSource: params.toolName === "image_generate",
      }),
    },
  ];
  const triggerMessage =
    formatAgentInternalEventsForPrompt(internalEvents) ||
    `A ${params.completionLabel} generation task finished. Process the completion update now.`;
  const delivery = await deliverSubagentAnnouncement({
    requesterSessionKey: params.handle.requesterSessionKey,
    requesterAgentId: params.handle.requesterAgentId,
    targetRequesterSessionKey: params.handle.requesterSessionKey,
    triggerMessage,
    steerMessage: triggerMessage,
    internalEvents,
    requesterSessionOrigin: params.handle.requesterOrigin,
    completionDirectOrigin: params.handle.requesterOrigin,
    directOrigin: params.handle.requesterOrigin,
    sourceSessionKey: `${params.toolName}:${params.handle.taskId}`,
    sourceTool: params.toolName,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: announceId,
  });
  if (delivery.delivered) {
    return { status: "delivered" };
  }
  if (
    delivery.disposition === "session_queued" ||
    delivery.reason === "completion_handoff_pending"
  ) {
    return { status: "pending" };
  }
  if (delivery.disposition === "ambiguous") {
    log.warn("Media generation completion delivery stopped after terminal fallback", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
    // Send evidence makes another attempt unsafe even when the transport's
    // terminal acknowledgment failed, so settle without risking a duplicate.
    return { status: "delivered" };
  }
  if (delivery.error) {
    log.error("Media generation completion wake failed; requester session was not woken", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
  }
  return { status: "permanent_failure" };
}
