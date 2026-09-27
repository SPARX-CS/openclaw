import { describe, expect, it } from "vitest";
import {
  evaluateMemoryWrite,
  extractMemoryClaimTokens,
  renderMemoryWriteSourceMessages,
  type MemoryWriteSource,
} from "./memory-write-gate.js";

function transcript(text: string): MemoryWriteSource[] {
  return [{ ref: { kind: "session-transcript", sessionId: "session-1" }, text }];
}

function evaluate(contentAfter: string, sourceText: string, contentBefore = "") {
  return evaluateMemoryWrite({ contentBefore, contentAfter, sources: transcript(sourceText) });
}

describe("memory write gate", () => {
  const source =
    "User: The invoice for Contoso is $1,200, due 2026-10-01. Details at https://example.com/inv/42 and docs/billing.md. " +
    'Ms. Rivera said "ship it after review".';

  it("accepts a line whose key tokens all appear in the source", () => {
    const result = evaluate(
      "- Contoso invoice: $1,200 due 2026-10-01 (https://example.com/inv/42, docs/billing.md)\n" +
        '- Rivera said "ship it after review"\n',
      source,
    );
    expect(result).toEqual({
      ok: true,
      checkedLines: 2,
      sourceRefs: [{ kind: "session-transcript", sessionId: "session-1" }],
    });
  });

  it("rejects a changed number or amount and names the failing line", () => {
    const result = evaluate("# Notes\n- Contoso invoice: $1,300 due 2026-10-03\n", source);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== "unsupported-lines") {
      throw new Error("expected unsupported lines");
    }
    expect(result.rejections).toEqual([
      {
        lineNumber: 2,
        line: "- Contoso invoice: $1,300 due 2026-10-03",
        reason: "unsupported-claim",
        missing: [
          { kind: "amount", token: "USD 1300" },
          { kind: "number", token: "2026-10-03" },
        ],
      },
    ]);
    expect(result.message).toContain("line 2: contains values not present in the source");
    expect(result.message).toContain("Nothing was written.");
  });

  it("rejects a currency that the source does not state", () => {
    const result = evaluate("- Contoso invoice: ¥1,200\n", source);
    expect(result).toMatchObject({
      ok: false,
      rejections: [{ missing: [{ kind: "amount", token: "JPY 1200" }] }],
    });
  });

  it.each([
    ["mid-sentence capitalized name", "- The invoice was approved by Hartley", "Hartley"],
    ["value after a label", "- Customer: Hartley", "Hartley"],
    ["title prefix at sentence start", "Mr. Hartley approved the invoice", "Hartley"],
    ["romanized honorific", "- follow up with hartley-san next week", "hartley"],
  ])("rejects an invented person name (%s)", (_name, line, token) => {
    const result = evaluate(`${line}\n`, source);
    expect(result).toMatchObject({
      ok: false,
      code: "unsupported-lines",
      rejections: [{ reason: "unsupported-name", missing: [expect.objectContaining({ token })] }],
    });
  });

  it("accepts names present in the source regardless of case", () => {
    expect(evaluate("- Invoice owner is rivera at contoso\n- Owner: Rivera\n", source).ok).toBe(
      true,
    );
  });

  it("rejects writes without a resolvable source reference", () => {
    for (const sources of [
      [],
      [{ ref: { kind: "session-transcript" as const, sessionId: "" }, text: source }],
      [{ ref: { kind: "session-transcript" as const, sessionId: "s" }, text: "  " }],
    ]) {
      expect(
        evaluateMemoryWrite({ contentBefore: "", contentAfter: "- note\n", sources }),
      ).toMatchObject({ ok: false, code: "missing-source" });
    }
    expect(
      evaluateMemoryWrite({
        contentBefore: "",
        contentAfter: "- note\n",
        sources: [{ ref: { kind: "hook-metadata", label: "x" }, text: "note" }],
        requireRefKind: "session-transcript",
      }),
    ).toMatchObject({ ok: false, code: "missing-source" });
  });

  it("does not require a source for deletions or unchanged lines", () => {
    expect(
      evaluateMemoryWrite({
        contentBefore: "- Old claim about Hartley\n- keep\n",
        contentAfter: "- keep\n",
        sources: [],
      }),
    ).toMatchObject({ ok: true, checkedLines: 0 });
    expect(
      evaluate(
        "- Old claim about Hartley\n- new plain line\n",
        "plain",
        "- Old claim about Hartley\n",
      ),
    ).toMatchObject({
      ok: true,
      checkedLines: 1,
    });
  });

  it("checks CJK names bound to honorifics and katakana runs", () => {
    const cjkSource = "田中さんから、見積もりは12万円でタナカ商事宛てと連絡がありました。";
    expect(evaluate("- 田中さん: 見積もり12万円、タナカ商事宛て\n", cjkSource).ok).toBe(true);
    expect(evaluate("- 鈴木様: 見積もり12万円\n", cjkSource)).toMatchObject({
      ok: false,
      rejections: [{ reason: "unsupported-name", missing: [{ kind: "cjk-name", token: "鈴木" }] }],
    });
    expect(evaluate("- 見積もりはヤマダ商事宛て\n", cjkSource)).toMatchObject({
      ok: false,
      rejections: [{ missing: [{ kind: "cjk-name", token: "ヤマダ" }] }],
    });
    expect(evaluate("- 見積もりは15万円\n", cjkSource)).toMatchObject({
      ok: false,
      rejections: [{ reason: "unsupported-claim", missing: [{ kind: "number", token: "15" }] }],
    });
  });

  it("normalizes full-width digits and thousands separators", () => {
    expect(evaluate("- 合計は１２００円\n", "合計は1,200円です").ok).toBe(true);
  });

  it("exempts heading words and sentence-initial words from the proper-noun rule", () => {
    expect(extractMemoryClaimTokens("## Weekly Planning Notes")).toEqual([]);
    expect(extractMemoryClaimTokens("Prefers short answers. Always cite sources.")).toEqual([]);
    // A colon does not start a sentence, so label words after the first are checked.
    expect(extractMemoryClaimTokens("- **Decision Owner**: see thread")).toEqual([
      { kind: "proper-noun", token: "Owner" },
    ]);
  });

  it("uses digit boundaries so a number does not match inside a longer one", () => {
    expect(evaluate("- budget is 12\n", "the year 2012").ok).toBe(false);
    expect(evaluate("- meeting at 10:00\n", "starts 10:00:00 UTC").ok).toBe(true);
  });

  it("diffs lines as a multiset", () => {
    const result = evaluate("a\nb 41\nb 42\n\n---\nc 43", "a b 41", "a\nb 41\n");
    expect(result.ok).toBe(false);
    expect(
      result.ok === false && result.code === "unsupported-lines"
        ? result.rejections.map((rejection) => [rejection.lineNumber, rejection.line])
        : [],
    ).toEqual([
      [3, "b 42"],
      [6, "c 43"],
    ]);
  });

  it("renders only evidence messages from a transcript", () => {
    const text = renderMemoryWriteSourceMessages([
      { role: "user", content: [{ type: "text", text: "user says Contoso" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "assistant claims Hartley" },
          { type: "toolCall", name: "write", arguments: { content: "Hartley" } },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "tool saw 42" }] },
      { role: "toolResult", isError: true, content: [{ type: "text", text: "failed Hartley" }] },
      {
        role: "toolResult",
        content: [{ type: "text", text: "Memory write rejected: - line 1 Hartley" }],
      },
      { role: "bashExecution", command: "ls", output: "notes.md" },
    ]);
    expect(text).toBe("user says Contoso\ntool saw 42\nls\nnotes.md");
  });
});
