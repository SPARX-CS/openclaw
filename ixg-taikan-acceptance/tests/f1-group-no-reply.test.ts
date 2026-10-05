// F1: the model decides to stay silent in a group (NO_REPLY). The user must not see the fixed
// English fallback ("did not produce a visible reply...") in the group, while direct chats keep
// being answered.
//
// Each case asserts the DESIRED behavior. A case that fails on a given version is a "not passing"
// row in the acceptance table; the `default` cases show what needs a config key to be fixed.
//
// Derived from the seed test `groupjudge-no-reply.test.ts` (ixg order 20261005). The "channel" is
// a stand-in id; LINE WORKS' plugin is not used. The production plugin passes ChatType but not
// WasMentioned, so both "mention info absent" and "mention info present" are covered.
import { describe, expect, it } from "vitest";
import {
  resolveReplyCompletion,
  resolveReplyExpectation,
} from "../../src/agents/reply-completion.js";
import { buildEmptyInteractiveReplyPayload } from "../../src/auto-reply/reply/agent-runner-failure-reply.js";
import { normalizeReplyPayloadOutcome } from "../../src/auto-reply/reply/normalize-reply.js";
import { resolveSourceReplyExpectation } from "../../src/auto-reply/reply/source-reply-delivery-mode.js";
import { SILENT_REPLY_TOKEN } from "../../src/auto-reply/tokens.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const CHANNEL = "testchannel";
const absent: OpenClawConfig = {};
const groupAllow: OpenClawConfig = {
  surfaces: { [CHANNEL]: { silentReply: { group: "allow" } } },
};
const directAllowAttempt: OpenClawConfig = {
  surfaces: { [CHANNEL]: { silentReply: { group: "allow", direct: "allow" } } },
} as OpenClawConfig;

type Mention = "mentioned" | "not-mentioned" | "unknown";

/** Text the user would see after the model answered NO_REPLY and nothing else happened. */
function textShownForNoReply(params: {
  cfg: OpenClawConfig;
  chatType: "group" | "direct";
  mention?: Mention;
  isHeartbeat?: boolean;
  cron?: boolean;
}): string | undefined {
  const mention = params.mention ?? "unknown";
  const expectation = params.cron
    ? // cron/isolated-agent owns terminalReplyExpectation explicitly.
      resolveReplyExpectation({ terminalReplyExpectation: "optional", trigger: "cron" })
    : resolveSourceReplyExpectation({
        cfg: params.cfg,
        ctx: {
          Provider: CHANNEL,
          Surface: CHANNEL,
          ChatType: params.chatType,
          InboundEventKind: "user_request",
          ...(mention === "unknown" ? {} : { WasMentioned: mention === "mentioned" }),
        },
        isHeartbeat: params.isHeartbeat,
      });
  // The silent token is suppressed by normalization, so no visible payload is left behind.
  expect(normalizeReplyPayloadOutcome({ text: SILENT_REPLY_TOKEN })).toEqual({
    kind: "suppress",
    reason: "silent",
  });
  const payload = buildEmptyInteractiveReplyPayload({
    completion: resolveReplyCompletion(expectation, "empty"),
  });
  return payload?.text;
}

describe("F1 group NO_REPLY must not surface the fixed fallback", () => {
  it("F1.1 default config: group, mention info absent -> silent (needs surfaces.<ch>.silentReply.group=allow)", () => {
    expect(
      textShownForNoReply({ cfg: absent, chatType: "group", mention: "unknown" }),
    ).toBeUndefined();
  });

  it("F1.2 group=allow: group, mention info absent -> silent", () => {
    expect(
      textShownForNoReply({ cfg: groupAllow, chatType: "group", mention: "unknown" }),
    ).toBeUndefined();
  });

  it("F1.3 group=allow: group, not mentioned -> silent", () => {
    expect(
      textShownForNoReply({ cfg: groupAllow, chatType: "group", mention: "not-mentioned" }),
    ).toBeUndefined();
  });

  it("F1.4 group=allow: group, explicitly mentioned -> still answered (never silent)", () => {
    const text = textShownForNoReply({ cfg: groupAllow, chatType: "group", mention: "mentioned" });
    expect(text).toBeTruthy();
    expect(text).not.toBe(SILENT_REPLY_TOKEN);
  });

  it("F1.5 default config: group, explicitly mentioned -> answered", () => {
    expect(
      textShownForNoReply({ cfg: absent, chatType: "group", mention: "mentioned" }),
    ).toBeTruthy();
  });

  it.each([
    ["default", absent],
    ["group=allow", groupAllow],
    ["group+direct=allow attempt", directAllowAttempt],
  ])("F1.6 direct is always answered (%s)", (_name, cfg) => {
    expect(textShownForNoReply({ cfg, chatType: "direct" })).toBeTruthy();
  });

  it.each([
    ["default", absent],
    ["group=allow", groupAllow],
  ])("F1.7 cron and heartbeat stay silent (%s)", (_name, cfg) => {
    expect(textShownForNoReply({ cfg, chatType: "group", cron: true })).toBeUndefined();
    expect(textShownForNoReply({ cfg, chatType: "group", isHeartbeat: true })).toBeUndefined();
  });

  it("F1.8 the fallback, when shown, is the fixed English sentence (documents the production symptom)", () => {
    const text = textShownForNoReply({ cfg: absent, chatType: "direct" });
    expect(text).toContain("did not produce a visible reply");
    expect(text?.length).toBe(126);
  });
});
