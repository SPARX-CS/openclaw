import { describe, expect, it } from "vitest";
import { buildSessionContinuityEntry } from "./session-continuity-record.js";

let seq = 0;
function message(id: string, payload: Record<string, unknown>, parentId?: string) {
  seq += 1;
  return {
    type: "message",
    id,
    parentId: parentId ?? null,
    timestamp: new Date(Date.UTC(2026, 8, 26, 0, seq)).toISOString(),
    message: payload,
  };
}

function chain(...entries: ReturnType<typeof message>[]) {
  entries.forEach((entry, index) => {
    entry.parentId = entries[index - 1]?.id ?? null;
  });
  return entries;
}

const build = (events: unknown[], maxChars?: number) =>
  buildSessionContinuityEntry({
    loadEvents: () => events,
    boundaryId: "boundary",
    reason: "idle",
    sessionId: "s1",
    sessionKey: "agent:main:main",
    now: new Date(Date.UTC(2026, 8, 26, 12)),
    ...(maxChars ? { maxChars } : {}),
  });

describe("buildSessionContinuityEntry", () => {
  it("returns nothing for an empty window", () => {
    expect(build([])).toBeUndefined();
  });

  it("marks a request whose tool call never returned as tool-pending", () => {
    const entry = build(
      chain(
        message("u1", { role: "user", content: "Book the meeting room for Friday 10:00." }),
        message("a1", {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "calendar_create",
              arguments: { target: "room-7" },
            },
          ],
        }),
      ),
    );
    expect(entry?.details.openRequests).toEqual([
      expect.objectContaining({ entryId: "u1", status: "tool-pending" }),
    ]);
    expect(entry?.details.deliverables).toEqual([
      {
        entryId: "a1",
        tool: "calendar_create",
        locations: ["target=room-7"],
        outcome: "no-result",
      },
    ]);
    // A reservation without a result must not be presented as done.
    expect(entry?.content).toContain("calendar_create [no-result]");
  });

  it("ignores read-only tools and only reads the window after the latest earlier reset", () => {
    const entry = build([
      message("old", { role: "user", content: "An old request from a previous window" }),
      { type: "reset", id: "r0", parentId: "old", timestamp: "2026-09-25T00:00:00.000Z" },
      message("u1", { role: "user", content: "Summarise the file" }, "r0"),
      message(
        "a1",
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a.md" } }],
        },
        "u1",
      ),
    ]);
    expect(entry?.content).not.toContain("An old request");
    expect(entry?.details.deliverables).toEqual([]);
    expect(entry?.details.windowFirstEntryId).toBe("u1");
  });

  it("drops the oldest statements first and says so when over budget", () => {
    const events = chain(
      ...Array.from({ length: 30 }, (_, index) =>
        message(`u${index}`, { role: "user", content: `statement ${index} ${"x".repeat(300)}` }),
      ),
    );
    const entry = build(events, 4_000)!;
    expect(entry.content.length).toBeLessThanOrEqual(4_000);
    expect(entry.details.complete).toBe(false);
    expect(entry.details.omittedUserStatementIds[0]).toBe("u0");
    expect(entry.content).toContain("Coverage: PARTIAL");
    expect(entry.content).toContain("earlier user statements omitted (entries u0");
    // The newest statement always survives.
    expect(entry.content).toContain("statement 29");
  });

  it("replaces an over-budget record with an explicit retrieval notice", () => {
    const entry = build(chain(message("u1", { role: "user", content: "y".repeat(5_000) })), 600)!;
    expect(entry.details.unavailable).toBe("record-over-budget");
    expect(entry.content).toContain("Coverage: NONE");
    expect(entry.content).toContain("do not guess");
  });

  it("yields an unavailable record instead of throwing when the window cannot be read", () => {
    const entry = buildSessionContinuityEntry({
      loadEvents: () => {
        throw new Error("storage unavailable");
      },
      boundaryId: "boundary",
      reason: "daily",
      sessionId: "s1",
      sessionKey: "agent:main:main",
    })!;
    expect(entry.parentId).toBe("boundary");
    expect(entry.details).toMatchObject({ complete: false, unavailable: "Error", reason: "daily" });
    expect(entry.content).toContain("retrieve it or ask the user");
  });
});
