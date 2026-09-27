// The compact cron description must keep every behavioral rule it carried.
import { describe, expect, it } from "vitest";
import { createCronTool } from "./cron-tool.js";

describe("cron tool description", () => {
  it.each([
    // Ceilings are the pre-compaction description lengths; the compact text must stay shorter.
    { triggersEnabled: true, previousLength: 5324 },
    { triggersEnabled: false, previousLength: 4768 },
  ])(
    "keeps behavioral constraints in the compact description (triggers=$triggersEnabled)",
    ({ triggersEnabled, previousLength }) => {
      const tool = createCronTool({
        config: { cron: { triggers: { enabled: triggersEnabled } } },
      });
      for (const phrase of [
        "add job (requires schedule+payload)",
        "partial: only supplied fields change; null clears",
        'next_check in:"30m" (own paced run only)',
        'wake text mode?:"now"|"next-heartbeat"(default) nudges a caller-owned lane',
        "auto-deletes after successful completion",
        "failed/unknown required delivery retains it disabled",
        "timeoutSeconds 0=none",
        "clamped to bounds, from run end; failed runs keep normal backoff",
        "no messaging tool inside the run",
        "A current announce succeeds only after its history commit",
        "successful empty summary = intentional silence, no POST",
        'completionDestination:{mode:"webhook"',
        "after 2 consecutive execution failures, 1h cooldown",
        "failureAlert:false disables execution/delivery alerts, not the auto-disable safety notice",
        "bestEffort suppresses inherited execution alerts",
        "does not increment the execution streak",
        "Restricted automation-run sessions: self status/list/get/runs/remove + own next_check only",
        "jobId canonical (id=compat)",
        "contextMessages 0-10",
      ]) {
        expect(tool.description).toContain(phrase);
      }
      if (triggersEnabled) {
        expect(tool.description).toContain(
          '{kind:"script",script}: main|isolated only; disabled only when cron.triggers.enabled=false',
        );
      } else {
        expect(tool.description).toContain(
          "never model-poll instead or silently create an unconditional job in its place",
        );
      }
      expect(tool.description.length).toBeLessThan(previousLength);
    },
  );
});
