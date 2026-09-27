// Continuity across the automatic idle reset, exercised on the real session
// initializer, SQLite transcript store, claude-cli prompt preparation and native
// binding finalizer. No model runs here: the assertions stop at the prompt the
// CLI receives and at the binding the finalizer is allowed to publish.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../../agents/cli-runner.test-helpers.js";
import { prepareCliRunContext } from "../../agents/cli-runner/prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../../agents/cli-runner/prepare.test-support.js";
import { persistCliSessionBindingResult } from "../../agents/cli-session-store.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { initSessionState } from "./test/session.test-support.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

const HOUR_MS = 60 * 60 * 1000;
const PROVIDER = "test-cli";
const SAVE_PATH = "/workspace/out/proposal-q3.pptx";
const DRIVE_FOLDER = "Proposals/2026-Q3";
const OPEN_REQUEST =
  "Change the price on slide 3 to 12,000 yen and re-save to the same folder, replacing the file.";

describe("session continuity across the automatic idle reset", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  async function ownedHistory() {
    const agentDir = path.join(fixture.session.dir, "agents", "main", "agent");
    const authProfileId = "continuity-test:account";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: { type: "token", provider: PROVIDER, token: "synthetic-account" },
          "continuity-test:other": { type: "token", provider: PROVIDER, token: "synthetic-other" },
        },
      },
      agentDir,
    );
    const first = await fixture.prepare({ agentDir, authProfileId });
    cleanups.push(() => first.preparedBackend.cleanup?.());
    expect(first.cliHistoryWriter).toBeDefined();
    let parentId: string | null = null;
    let clock = Date.now() - 10 * HOUR_MS;
    return {
      append(id: string, message: Record<string, unknown>) {
        clock += 60_000;
        const entry = {
          id,
          parentId,
          timestamp: new Date(clock).toISOString(),
          message: { timestamp: clock, ...message },
        };
        parentId = id;
        runWithCliHistoryWriter(first.cliHistoryWriter, () => fixture.appendTranscript(entry));
      },
      prepare: async (overrides: Parameters<typeof fixture.prepare>[0] = {}) => {
        const context = await fixture.prepare({
          agentDir,
          authProfileId,
          admittedRunContext: first.params.admittedRunContext,
          sessionKey: fixture.session.sessionTarget.sessionKey,
          prompt: "Please continue.",
          ...overrides,
        });
        cleanups.push(() => context.preparedBackend.cleanup?.());
        return context;
      },
    };
  }

  function assistant(content: unknown[], stopReason: string) {
    return {
      role: "assistant",
      content,
      api: "responses",
      provider: PROVIDER,
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason,
    };
  }

  /** A saved deliverable, then an unfinished change request interrupted before completion. */
  function seedConversation(history: Awaited<ReturnType<typeof ownedHistory>>) {
    history.append("u-deck", {
      role: "user",
      content: `Turn the attached price sheet into a 5-slide proposal deck and save it to the shared drive folder ${DRIVE_FOLDER}.`,
    });
    history.append(
      "a-write",
      assistant(
        [{ type: "toolCall", id: "call-write", name: "write", arguments: { path: SAVE_PATH } }],
        "toolUse",
      ),
    );
    history.append("r-write", {
      role: "toolResult",
      toolCallId: "call-write",
      toolName: "write",
      content: [{ type: "text", text: "wrote file" }],
      details: { path: SAVE_PATH },
      isError: false,
    });
    history.append(
      "a-upload",
      assistant(
        [
          {
            type: "toolCall",
            id: "call-upload",
            name: "drive_upload",
            arguments: { path: SAVE_PATH, folderId: DRIVE_FOLDER },
          },
        ],
        "toolUse",
      ),
    );
    history.append("r-upload", {
      role: "toolResult",
      toolCallId: "call-upload",
      toolName: "drive_upload",
      content: [{ type: "text", text: "uploaded" }],
      details: { webViewLink: "https://drive.example.test/file/abc" },
      isError: false,
    });
    history.append(
      "a-done",
      assistant([{ type: "text", text: "Saved the deck to the folder." }], "stop"),
    );
    history.append("u-change", { role: "user", content: OPEN_REQUEST });
    history.append("a-partial", assistant([{ type: "text", text: "Updating slide 3" }], "aborted"));
  }

  async function makeStale(options: { withBinding?: boolean } = {}) {
    const { sessionTarget } = fixture.session;
    const staleAt = Date.now() - 9 * HOUR_MS;
    replaceSessionEntrySync(sessionTarget, {
      // Keep the stored CLI history account proof established by the owned writer.
      ...loadSessionEntry({ ...sessionTarget, readConsistency: "latest" }),
      sessionId: sessionTarget.sessionId,
      // A new lifecycle consumes the fixture's legacy pending-reset marker (updatedAt=0).
      lifecycleRevision: `lifecycle-${Math.random().toString(36).slice(2)}`,
      updatedAt: staleAt,
      sessionStartedAt: staleAt - HOUR_MS,
      lastInteractionAt: staleAt,
      ...(options.withBinding
        ? { cliSessionBindings: { [PROVIDER]: { sessionId: "native-before-reset" } } }
        : {}),
    });
  }

  const idleConfig = () => ({
    session: {
      store: fixture.session.sessionTarget.storePath,
      reset: { mode: "idle" as const, idleMinutes: 480 },
    },
  });

  const expireAndInit = (body = "Please continue.") =>
    initSessionState({
      cfg: idleConfig(),
      ctx: {
        RawBody: body,
        ChatType: "direct",
        SessionKey: fixture.session.sessionTarget.sessionKey,
      },
    });

  async function continuityEvents() {
    const events = (await loadTranscriptEvents(fixture.session.sessionTarget)) as Array<
      Record<string, unknown>
    >;
    return {
      events,
      records: events.filter((event) => event.customType === "openclaw.session-continuity"),
      resets: events.filter((event) => event.type === "reset"),
    };
  }

  function sentPrompt(
    context: Awaited<ReturnType<Awaited<ReturnType<typeof ownedHistory>>["prepare"]>>,
  ) {
    // A fresh process run sends the history prompt; a resumed run sends params.prompt.
    return context.openClawHistoryPrompt ?? context.params.prompt;
  }

  beforeEach(() => {
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      vi.restoreAllMocks();
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      await fixture.cleanup();
    }
  });

  it("restores the save location and the unfinished request on the first fresh CLI turn after 8h expiry", async () => {
    const history = await ownedHistory();
    seedConversation(history);
    await makeStale({ withBinding: true });

    const init = await expireAndInit();
    expect(init.isNewSession).toBe(true);
    expect(init.resetTriggered).toBe(false);
    // Same transcript identity; the native binding was cleared in the reset transaction.
    expect(init.sessionEntry.sessionId).toBe(fixture.session.sessionTarget.sessionId);
    expect(getCliSessionBinding(init.sessionEntry, PROVIDER)).toBeUndefined();

    const { events, records, resets } = await continuityEvents();
    expect(resets).toHaveLength(1);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    // The record is the direct child of the boundary it belongs to.
    expect(record.parentId).toBe(resets[0]!.id);
    expect(events.indexOf(record)).toBe(events.indexOf(resets[0]!) + 1);
    expect(record.details).toMatchObject({
      reason: "idle",
      complete: true,
      openRequests: [{ entryId: "u-change", status: "interrupted" }],
      deliverables: [
        { tool: "write", outcome: "ok" },
        { tool: "drive_upload", outcome: "ok" },
      ],
    });

    const fresh = await history.prepare();
    expect(fresh.reusableCliSession).toEqual({ mode: "none" });
    const prompt = sentPrompt(fresh);
    expect(prompt).toContain("Session continuity record");
    expect(prompt).toContain(OPEN_REQUEST.slice(0, 40));
    expect(prompt).toContain(`path=${SAVE_PATH}`);
    expect(prompt).toContain(`folderId=${DRIVE_FOLDER}`);
    expect(prompt).toContain("https://drive.example.test/file/abc");
    expect(prompt).toContain('sessionId="session-test", messageId set to an entry id');
    expect(prompt).toContain("u-change");
    // The current ask is still sent exactly once, after the carried state.
    expect(prompt.indexOf("Session continuity record")).toBeLessThan(
      prompt.lastIndexOf("Please continue."),
    );
    // The record is context for the model, not part of the persisted user turn.
    expect(fresh.params.transcriptPrompt).toBe("Please continue.");
  });

  it("does not resend the record on a resumed turn inside the window", async () => {
    const history = await ownedHistory();
    seedConversation(history);
    await makeStale();
    await expireAndInit();

    const resumed = await history.prepare({ cliSessionId: "native-after-reset" });
    expect(resumed.reusableCliSession).toEqual({ mode: "reuse", sessionId: "native-after-reset" });
    expect(resumed.openClawHistoryPrompt).toBeUndefined();
    expect(resumed.params.prompt).not.toContain("Session continuity record");
  });

  it("does not write a record for a fresh session inside the window (no expiry)", async () => {
    const history = await ownedHistory();
    seedConversation(history);
    const { sessionTarget } = fixture.session;
    replaceSessionEntrySync(sessionTarget, {
      // Keep the stored CLI history account proof established by the owned writer.
      ...loadSessionEntry({ ...sessionTarget, readConsistency: "latest" }),
      sessionId: sessionTarget.sessionId,
      // A new lifecycle consumes the fixture's legacy pending-reset marker (updatedAt=0).
      lifecycleRevision: `lifecycle-${Math.random().toString(36).slice(2)}`,
      updatedAt: Date.now() - HOUR_MS,
      sessionStartedAt: Date.now() - 2 * HOUR_MS,
      lastInteractionAt: Date.now() - HOUR_MS,
    });
    const init = await expireAndInit();
    expect(init.isNewSession).toBe(false);
    const { records, resets } = await continuityEvents();
    expect(resets).toHaveLength(0);
    expect(records).toHaveLength(0);
    // Fresh native session inside the window keeps the stock reseed/notes path.
    const fresh = await history.prepare();
    expect(sentPrompt(fresh)).not.toContain("Session continuity record");
  });

  it("keeps condition changes in order so the later statement wins", async () => {
    const history = await ownedHistory();
    history.append("u-a", { role: "user", content: "Use the blue template for the deck." });
    history.append("a-a", assistant([{ type: "text", text: "Blue template noted." }], "stop"));
    history.append("u-b", {
      role: "user",
      content: "Actually switch to the green template instead.",
    });
    history.append("a-b", assistant([{ type: "text", text: "Green template noted." }], "stop"));
    await makeStale();
    await expireAndInit("Go ahead and build it.");

    const prompt = sentPrompt(await history.prepare({ prompt: "Go ahead and build it." }));
    const blue = prompt.indexOf("blue template");
    const green = prompt.indexOf("green template");
    expect(blue).toBeGreaterThan(-1);
    expect(green).toBeGreaterThan(blue);
    expect(prompt).toContain("a later statement overrides an earlier one");
    // The new post-reset instruction is the current turn, after the carried history.
    expect(prompt.lastIndexOf("Go ahead and build it.")).toBeGreaterThan(green);
  });

  it("withholds the record across an account boundary", async () => {
    const history = await ownedHistory();
    seedConversation(history);
    await makeStale();
    await expireAndInit();

    const other = await history.prepare({ authProfileId: "continuity-test:other" });
    const prompt = sentPrompt(other);
    expect(prompt).not.toContain("Session continuity record");
    expect(prompt).not.toContain(SAVE_PATH);
  });

  it("appends exactly one boundary and one record when expired turns race", async () => {
    const history = await ownedHistory();
    seedConversation(history);
    await makeStale();

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => expireAndInit(`turn ${index}`)),
    );
    expect(results.filter((result) => result.isNewSession)).toHaveLength(1);
    const { records, resets } = await continuityEvents();
    expect(resets).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  it("publishes the new native binding only from the post-reset lifecycle", async () => {
    const history = await ownedHistory();
    seedConversation(history);
    await makeStale({ withBinding: true });
    const { sessionTarget } = fixture.session;
    const beforeReset = loadSessionEntry({ ...sessionTarget, readConsistency: "latest" })!;
    const init = await expireAndInit();

    const result = (sessionId: string) =>
      ({
        payloads: [],
        meta: { durationMs: 1, agentMeta: { cliSessionBinding: { sessionId } } },
      }) as unknown as EmbeddedAgentRunResult;
    const target = {
      agentId: "main",
      provider: PROVIDER,
      sessionKey: sessionTarget.sessionKey,
      storePath: sessionTarget.storePath,
      assertSettlementCurrent: () => {},
    };
    // A run that started before the reset completes late: its lifecycle is gone.
    await persistCliSessionBindingResult({
      ...target,
      result: result("native-late"),
      expectedSession: beforeReset,
    });
    const afterLate = loadSessionEntry({ ...sessionTarget, readConsistency: "latest" })!;
    expect(getCliSessionBinding(afterLate, PROVIDER)).toBeUndefined();
    // Until a post-reset run completes, every fresh turn still receives the record.
    expect(sentPrompt(await history.prepare())).toContain("Session continuity record");

    await persistCliSessionBindingResult({
      ...target,
      result: result("native-after-reset"),
      expectedSession: init.sessionEntry,
    });
    const afterFresh = loadSessionEntry({ ...sessionTarget, readConsistency: "latest" })!;
    expect(getCliSessionBinding(afterFresh, PROVIDER)?.sessionId).toBe("native-after-reset");
  });
});
