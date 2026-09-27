// Harness pinning for embedded command attempts (split from attempt-execution.cli.test.ts).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Covers CLI-backed attempt execution and session-binding persistence.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createTestPreparedRunAdmission } from "../admitted-run-context.test-support.js";
import { createAuthProfileStoreFixture } from "../auth-profiles/credential-fixtures.test-support.js";
import { closeAuthProfileReadPool } from "../auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import type { ModelFallbackAttemptProvenance } from "../model-fallback.types.js";
import { runAgentAttempt as runAgentAttemptImpl } from "./attempt-execution.js";

type RunAgentAttemptParams = Parameters<typeof runAgentAttemptImpl>[0];
const runAgentAttempt = (params: RunAgentAttemptOverrides) =>
  runAgentAttemptImpl(makeRunAgentAttemptParams(params));

type RunAgentAttemptOverrides = Omit<
  Partial<RunAgentAttemptParams>,
  | "agentDir"
  | "modelRoutingProvenance"
  | "opts"
  | "runContext"
  | "sessionEntry"
  | "sessionKey"
  | "workspaceDir"
> & {
  agentDir: RunAgentAttemptParams["agentDir"];
  modelRoutingProvenance?: ModelFallbackAttemptProvenance;
  sessionEntry: NonNullable<RunAgentAttemptParams["sessionEntry"]>;
  sessionKey: NonNullable<RunAgentAttemptParams["sessionKey"]>;
  workspaceDir: RunAgentAttemptParams["workspaceDir"];
  opts?: Partial<RunAgentAttemptParams["opts"]>;
  runContext?: Partial<RunAgentAttemptParams["runContext"]>;
};

function makeRunAgentAttemptParams(overrides: RunAgentAttemptOverrides): RunAgentAttemptParams {
  const provider = overrides.providerOverride ?? "openai";
  const model = overrides.modelOverride ?? "gpt-5.4";
  const isFallbackRetry = overrides.isFallbackRetry ?? false;
  const runId = overrides.runId ?? `run-${overrides.sessionEntry.sessionId}`;
  const modelRoutingProvenance: ModelFallbackAttemptProvenance =
    overrides.modelRoutingProvenance ?? {
      requestedProvider: overrides.originalProvider ?? provider,
      requestedModel: model,
      stage: isFallbackRetry ? "fallback" : "initial",
    };
  return {
    providerOverride: provider,
    originalProvider: provider,
    modelOverride: model,
    cfg: {} as OpenClawConfig,
    sessionId: overrides.sessionEntry.sessionId,
    sessionAgentId: "main",
    sessionFile: path.join(overrides.workspaceDir, "session.jsonl"),
    body: "continue",
    isFallbackRetry,
    resolvedThinkLevel: "medium",
    timeoutMs: 1_000,
    runId,
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    onAgentEvent: vi.fn(),
    authProfileProvider: provider,
    sessionHasHistory: false,
    ...overrides,
    modelRoutingProvenance,
    pluginGeneration: overrides.pluginGeneration,
    preparedRunAdmission: overrides.preparedRunAdmission ?? createTestPreparedRunAdmission(runId),
    lifecycleGeneration: overrides.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    opts: { ...overrides.opts } as RunAgentAttemptParams["opts"],
    runContext: { ...overrides.runContext } as RunAgentAttemptParams["runContext"],
  };
}

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const hasClaudeSessionMock = vi.hoisted(() => vi.fn(() => false));
const providerAuthAliasMocks = vi.hoisted(() => ({
  resolveProviderAuthAliasMap: vi.fn(() => ({})),
  resolveProviderIdForAuth: vi.fn(
    (
      provider: string,
      params?: {
        metadataSnapshot?: {
          plugins?: readonly { providerAuthAliases?: Record<string, string> }[];
        };
      },
    ) => {
      const normalized = provider.trim().toLowerCase();
      for (const plugin of params?.metadataSnapshot?.plugins ?? []) {
        const alias = plugin.providerAuthAliases?.[normalized]?.trim();
        if (alias) {
          return alias.toLowerCase();
        }
      }
      return ["codex-cli", "openai"].includes(normalized) ? "openai" : normalized;
    },
  ),
}));
vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../cli-runner/cli-live-session-registry.js", () => ({
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: hasClaudeSessionMock,
}));

vi.mock("../model-selection.js", async () => ({
  ...(await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js")),
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) => {
    const normalized = provider.trim().toLowerCase();
    return (
      normalized === "claude-cli" ||
      normalized === "codex-cli" ||
      normalized === "google-gemini-cli"
    );
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: providerAuthAliasMocks.resolveProviderAuthAliasMap,
  resolveProviderIdForAuth: providerAuthAliasMocks.resolveProviderIdForAuth,
}));

vi.mock("../model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  );
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: ({
      provider,
      cfg,
      modelId,
    }: {
      provider?: string;
      cfg?: OpenClawConfig;
      modelId?: string;
    }) => {
      const key = provider && modelId ? `${provider}/${modelId}` : undefined;
      // Runtime alias tests only need the model-level runtime override path;
      // keeping the mock narrow avoids loading provider catalogs here.
      const runtime = key
        ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
        : undefined;
      return runtime || provider;
    },
  };
});

vi.mock("../embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

function makeSessionEntry(sessionId: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: Date.now(), ...overrides };
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockArg(mock: ReturnType<typeof vi.fn>, callIndex: number, label: string) {
  const arg = mock.mock.calls[callIndex]?.[0];
  if (arg === undefined) {
    throw new Error(`Expected mock argument for ${label}`);
  }
  return requireRecord(arg, label);
}

function expectMockArgFields(
  mock: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
  callIndex = 0,
) {
  expectRecordFields(requireMockArg(mock, callIndex, "mock call argument"), fields);
}

function firstEmbeddedAgentArg(callIndex = 0) {
  return requireMockArg(runEmbeddedAgentMock, callIndex, "embedded OpenClaw agent argument");
}

describe("embedded attempt harness pinning", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-attempt-"));
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockReset();
  });

  afterEach(async () => {
    closeAuthProfileReadPool({ kind: "root", rootPath: tmpDir });
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function runHarnessAttempt(
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "sessionKey" | "workspaceDir">,
  ) {
    return runAgentAttempt({
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      ...overrides,
    });
  }

  it("does not store a session harness pin for default OpenAI Codex routing", async () => {
    const sessionEntry = makeSessionEntry("legacy-session");
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      sessionEntry,
      runId: "run-legacy-runtime-pin",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, { agentHarnessId: undefined });
  });

  it("keeps a catalog-adopted Codex harness pinned for direct command attempts", async () => {
    const sessionEntry = makeSessionEntry("mixed-provider-session", {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      agentHarnessRuntimeOverride: "codex",
      body: "switch to minimax",
      runId: "run-mixed-provider-auto-runtime",
      sessionHasHistory: true,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "anthropic",
      model: "claude-opus-4-7",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
    });
  });

  it("ignores stale session Codex harness pins on non-OpenAI model switches", async () => {
    const sessionEntry = makeSessionEntry("mixed-provider-session", {
      agentHarnessId: "codex",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      providerOverride: "minimax",
      modelOverride: "minimax-m2.7",
      sessionEntry,
      body: "switch to minimax",
      runId: "run-mixed-provider-auto-runtime",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, { agentHarnessId: undefined });
  });

  it("does not leak a persisted CLI harness alias across providers", async () => {
    const sessionEntry = makeSessionEntry("legacy-cli-pin", {
      agentHarnessId: "claude-cli",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      sessionEntry,
      runId: "run-provider-incompatible-cli-pin",
      sessionHasHistory: true,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: undefined,
    });
  });

  it("forwards invocation tool restrictions into embedded attempts", async () => {
    const sessionEntry = makeSessionEntry("tools-allow-session");
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      sessionEntry,
      body: "read only",
      runId: "run-tools-allow",
      opts: { toolsAllow: ["read", "web_search"], codeModeOverride: false },
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      toolsAllow: ["read", "web_search"],
      codeModeOverride: false,
    });
  });

  it("lets provider/model runtime policy choose Codex without storing a session harness pin", async () => {
    const sessionEntry = makeSessionEntry("codex-history-session");
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      providerOverride: "codex",
      cfg: {
        models: {
          providers: {
            codex: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      runId: "run-codex-no-runtime-pin",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: undefined,
      agentHarnessRuntimePreparationHint: "codex",
    });
  });

  it("auto-forwards OpenAI Codex auth profiles to default Codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const sessionEntry = makeSessionEntry("codex-auth-session");
    saveAuthProfileStore(
      createAuthProfileStoreFixture({
        "openai:work": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
      tmpDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });

    try {
      await runHarnessAttempt({
        sessionEntry,
        runId: "run-codex-auto-auth-profile",
        sessionHasHistory: true,
      });
    } finally {
      clearAgentHarnesses();
    }

    expectMockArgFields(runEmbeddedAgentMock, {
      agentHarnessId: undefined,
      authProfileId: "openai:work",
      authProfileIdSource: "auto",
    });
  });

  it("pins a fresh OpenAI session to the Codex harness by default", async () => {
    const sessionEntry = makeSessionEntry("fresh-session");
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      sessionEntry,
      body: "start",
      runId: "run-fresh-no-pin",
    });

    expectMockArgFields(runEmbeddedAgentMock, { agentHarnessId: undefined });
  });

  it("honors a resolved persisted OpenClaw harness", async () => {
    const sessionEntry = makeSessionEntry("stale-agent-session", {
      agentHarnessId: "openclaw",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      sessionEntry,
      agentHarnessRuntimeOverride: "openclaw",
      runId: "run-stale-openai-runtime-pin",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: "openclaw",
    });
  });

  it.each([undefined, "model-owner"])(
    "honors a runtime request without promoting observations to a pin (owner %s)",
    async (pluginOwnerId) => {
      const sessionEntry = makeSessionEntry("explicit-openclaw-session", {
        agentRuntimeOverride: "openclaw",
        agentHarnessId: "codex",
        modelSelectionLocked: pluginOwnerId !== undefined,
        pluginOwnerId,
      });
      const modelThinkingCapability = {
        provider: "openai",
        modelId: "gpt-5.6-sol",
        agentRuntime: "openclaw",
        route: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
        compat: {
          thinkingFormat: "openai",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      } as const;
      runEmbeddedAgentMock.mockResolvedValueOnce({
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult);

      await runHarnessAttempt({
        modelOverride: "gpt-5.6-sol",
        modelThinkingCapability,
        sessionEntry,
        agentHarnessRuntimeOverride: "openclaw",
        resolvedThinkLevel: "max",
        runId: "run-explicit-openclaw-runtime",
        sessionHasHistory: true,
      });

      expectMockArgFields(runEmbeddedAgentMock, {
        provider: "openai",
        model: "gpt-5.6-sol",
        modelThinkingCapability,
        agentHarnessId: undefined,
        agentHarnessRuntimeOverride: "openclaw",
        thinkLevel: "max",
      });
    },
  );

  it("routes explicit OpenAI native runs with legacy Codex OAuth through OpenClaw", async () => {
    const sessionEntry = makeSessionEntry("explicit-agent-codex-oauth-session", {
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "openclaw" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      runId: "run-openai-agent-codex-oauth",
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: "openclaw",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
    });
  });

  it("does not pass CLI runtime aliases as embedded harness ids for fallback providers", async () => {
    const sessionEntry = makeSessionEntry("fallback-session");
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runHarnessAttempt({
      originalProvider: "claude-cli",
      modelRoutingProvenance: {
        requestedProvider: "claude-cli",
        requestedModel: "opus",
        stage: "fallback",
      },
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli" },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      body: "fallback",
      isFallbackRetry: true,
      runId: "run-openai-fallback-with-cli-runtime",
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(firstEmbeddedAgentArg()).not.toHaveProperty("agentHarnessId", "claude-cli");
  });
});
