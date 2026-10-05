// F4 (configuration pair): the Claude subscription quota is exhausted for the claude-cli candidate.
// There is no bundled "wait for the reset and resume" mechanism (see f4-quota-exhausted-turn.test.ts),
// but a fallback candidate on ANOTHER quota pool (another provider / an API key) lets the same
// request finish with real content right away. This pair pins which config makes that happen.
//
// Seam: the real runWithModelFallback (src/agents/model-fallback-runner.ts) with a fake `run`
// callback, same pattern as src/agents/model-fallback.chain-stop.test.ts. `fallbacksOverride` is the
// option the reply layer fills from config `agents.defaults.model.fallbacks`
// (config/zod-schema.agent-model.ts); cfg stays undefined so no auth store / network is touched.
// The error thrown for the claude-cli candidate is built like production does: Claude stream-json
// is_error result -> parseCliOutput -> createCliOutputFailoverError (classifier of THIS tree).
import { describe, expect, it, vi } from "vitest";
import { parseCliOutput } from "../../src/agents/cli-output.js";
import { createCliOutputFailoverError } from "../../src/agents/cli-runner/output-error.js";
import { runWithModelFallback } from "../../src/agents/model-fallback-runner.js";

vi.mock("../../src/plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: () => undefined,
}));

const NOTICE = "You've hit your session limit · resets 3pm (UTC)";
const REAL_CONTENT = "SUMMARY: the report says revenue grew 12% quarter over quarter.";

function claudeSessionLimitError() {
  const raw = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-quota" }),
    JSON.stringify({
      type: "assistant",
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: NOTICE }],
      },
      session_id: "s-quota",
      error: "rate_limit",
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: NOTICE,
      session_id: "s-quota",
    }),
  ].join("\n");
  const output = parseCliOutput({
    raw,
    backend: {
      command: "claude",
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      sessionIdFields: ["session_id"],
    } as never,
    providerId: "claude-cli",
    outputMode: "jsonl",
  });
  const error = createCliOutputFailoverError({ output, provider: "claude-cli", model: "opus-4.5" });
  if (!error) {
    throw new Error("expected a failover error");
  }
  return error;
}

/** claude-cli always dies with the quota notice; any other provider answers. */
function makeRun() {
  return vi.fn(async (provider: string) => {
    if (provider === "claude-cli") {
      throw claudeSessionLimitError();
    }
    return { text: REAL_CONTENT, provider };
  });
}

const base = {
  cfg: undefined,
  provider: "claude-cli",
  model: "opus-4.5",
  manifestPlugins: [],
  sessionId: "f4-fallback-session",
  lane: "f4-fallback-lane",
};

describe("F4.8 quota exhausted: does the same request still finish with real content?", () => {
  it("F4.8 default (no agents.defaults.model.fallbacks): the request ends with the real content", async () => {
    const run = makeRun();
    const outcome = await runWithModelFallback({ ...base, fallbacksOverride: [], run }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(
      outcome.ok ? (outcome.result.result as { text: string }).text : String(outcome.error),
      `candidates tried=${run.mock.calls.length}`,
    ).toBe(REAL_CONTENT);
  });

  it("F4.8b agents.defaults.model.fallbacks=[<provider on another quota pool>]: the request ends with the real content", async () => {
    const run = makeRun();
    const result = await runWithModelFallback({
      ...base,
      fallbacksOverride: ["fixture-api/gpt-fixture"],
      run,
    });
    expect((result.result as { text: string }).text).toBe(REAL_CONTENT);
    expect(run.mock.calls.map((call) => call[0])).toEqual(["claude-cli", "fixture-api"]);
  });

  it("F4.8c (record) a fallback on the SAME subscription does not help: two claude-cli models both hit the limit", async () => {
    const run = makeRun();
    await expect(
      runWithModelFallback({ ...base, fallbacksOverride: ["claude-cli/sonnet-4.5"], run }),
    ).rejects.toThrow(/session limit|All models failed/i);
    expect(run.mock.calls.map((call) => call[0])).toEqual(["claude-cli", "claude-cli"]);
  });
});
