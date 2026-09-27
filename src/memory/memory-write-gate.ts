/**
 * Deterministic memory write gate.
 *
 * Runs before a memory artifact write lands (see memory-write-provenance.ts)
 * and refuses content whose added lines are not lexically supported by the
 * write's referenced source text.
 *
 * This is a LEXICAL SUPPORT check, not a semantic truth check. For every added
 * line it extracts "key tokens" and requires each one to appear in the source:
 *   - numbers (thousands separators removed, digit-boundary match)
 *   - money amounts (number + currency class must co-occur in the source)
 *   - URLs, file paths, quoted/backticked strings (substring match)
 *   - Latin capitalized words that are not at sentence start (case-insensitive
 *     whole-word match), plus names bound to honorifics (Mr./Ms./Dr., -san, ...)
 *   - CJK names bound to honorifics (さん/様/氏/...) and katakana runs
 * A line with no key tokens passes: paraphrase and negation are not detected.
 * Sentence-initial capitalized words and heading words are exempt from the
 * Latin proper-noun rule because English capitalizes them regardless of role;
 * a colon does not start a sentence, so "Customer: Smith" still checks Smith.
 */
import type { MemoryArtifactSourceRef } from "./memory-artifact-provenance.js";

export type MemoryWriteSourceRef = MemoryArtifactSourceRef;

export type MemoryWriteSource = {
  ref: MemoryWriteSourceRef;
  text: string;
};

type MemoryClaimTokenKind =
  | "number"
  | "amount"
  | "url"
  | "path"
  | "quote"
  | "proper-noun"
  | "honorific-name"
  | "cjk-name";

export type MemoryClaimToken = { kind: MemoryClaimTokenKind; token: string };

export type MemoryWriteLineRejection = {
  lineNumber: number;
  line: string;
  reason: "unsupported-claim" | "unsupported-name";
  missing: MemoryClaimToken[];
};

export type MemoryWriteGateResult =
  | { ok: true; checkedLines: number; sourceRefs: MemoryWriteSourceRef[] }
  | { ok: false; code: "missing-source"; message: string }
  | {
      ok: false;
      code: "unsupported-lines";
      message: string;
      rejections: MemoryWriteLineRejection[];
    };

export const MEMORY_WRITE_GATE_VERSION = "lexical-v1";
const REJECTION_PREFIX = "Memory write rejected:";

const NAME_TOKEN_KINDS = new Set<MemoryClaimTokenKind>([
  "proper-noun",
  "honorific-name",
  "cjk-name",
]);

// Capitalized words that carry no identity even mid-sentence.
const CAPITALIZED_ALLOWLIST = new Set(["i", "i'm", "i've", "i'll", "i'd", "ok", "todo", "fyi"]);

const LATIN_HONORIFIC_PREFIX = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?\s+(\p{L}[\p{L}\p{M}'’-]*)/gu;
const LATIN_HONORIFIC_SUFFIX =
  /(?<![\p{L}\p{N}])(\p{L}[\p{L}\p{M}]*)[- ](?:san|sama|kun|chan|sensei|shi)(?![\p{L}\p{N}])/giu;
const CJK_HONORIFIC =
  /([\p{Script=Han}\p{Script=Katakana}ー・]{1,8})(?:さん|さま|様|氏|殿|くん|君|ちゃん|先生)/gu;
const KATAKANA_RUN = /[\p{Script=Katakana}ー・]{2,}/gu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/giu;
const QUOTE_PATTERN = /"([^"\n]{2,})"|“([^”\n]{2,})”|「([^」\n]{2,})」|`([^`\n]{2,})`/gu;
const PATH_PATTERN =
  /(?<![\p{L}\p{N}_])(?:(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)*\/?|[\w.@-]+(?:\/[\w.@-]+){2,}\/?|(?:[\w.@-]+\/)*[\w@-]+\.(?:md|mdx|ts|tsx|js|mjs|cjs|jsx|json|jsonl|ya?ml|toml|py|rb|go|rs|java|kt|swift|sh|txt|csv|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|html?|css|sql|log|env|lock|ini|conf))(?![\p{L}\p{N}_])/giu;
const CURRENCY_CLASSES: Array<{ id: string; pattern: string }> = [
  { id: "USD", pattern: String.raw`\$|USD|dollars?|ドル` },
  { id: "JPY", pattern: String.raw`¥|円|JPY|yen` },
  { id: "EUR", pattern: String.raw`€|EUR|euros?` },
  { id: "GBP", pattern: String.raw`£|GBP|pounds?` },
];
const AMOUNT_NUMBER = String.raw`\d+(?:\.\d+)?`;
const NUMBER_PATTERN = /\d+(?:[.:/-]\d+)*/gu;

/** NFKC, thousands separators removed, whitespace collapsed; applied to claims and sources alike. */
function normalizeMemoryGateText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/(\d),(?=\d{3}(?!\d))/gu, "$1")
    .replace(/[ \t 　]+/gu, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function currencyClassOf(marker: string): string | undefined {
  return CURRENCY_CLASSES.find(({ pattern }) => new RegExp(`^(?:${pattern})$`, "iu").test(marker))
    ?.id;
}

function collectAmounts(text: string): Array<{ number: string; currency: string; match: string }> {
  const markers = CURRENCY_CLASSES.map(({ pattern }) => pattern).join("|");
  const pattern = new RegExp(
    `(?:(${markers})\\s?(${AMOUNT_NUMBER}))|(?:(?<![\\d.])(${AMOUNT_NUMBER})\\s?(${markers}))`,
    "giu",
  );
  const out: Array<{ number: string; currency: string; match: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const marker = match[1] ?? match[4] ?? "";
    const number = match[2] ?? match[3] ?? "";
    const currency = currencyClassOf(marker);
    if (currency && number) {
      out.push({ number, currency, match: match[0] });
    }
  }
  return out;
}

function stripMarkdownPrefix(line: string): { text: string; heading: boolean } {
  const heading = /^\s{0,3}#{1,6}\s/u.test(line);
  const text = line
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/^\s*(?:>\s*)+/u, "")
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/u, "")
    .replace(/^\[[ xX]\]\s+/u, "");
  return { text, heading };
}

function isSentenceStart(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/[*_~"'“‘([【「\s]+$/u, "");
  // A colon does not start a sentence: "Customer: Smith" still names Smith.
  return before.trim().length === 0 || /[.!?。！？]$/u.test(before);
}

function blank(text: string, start: number, length: number): string {
  return text.slice(0, start) + " ".repeat(length) + text.slice(start + length);
}

function blankAll(text: string, pattern: RegExp, onMatch?: (match: RegExpMatchArray) => void) {
  let out = text;
  for (const match of text.matchAll(pattern)) {
    onMatch?.(match);
    out = blank(out, match.index ?? 0, match[0].length);
  }
  return out;
}

/** Extracts the key tokens a line must share with its source. */
export function extractMemoryClaimTokens(rawLine: string): MemoryClaimToken[] {
  const tokens: MemoryClaimToken[] = [];
  const push = (kind: MemoryClaimTokenKind, token: string) => {
    const trimmed = token.trim();
    if (trimmed && !tokens.some((entry) => entry.kind === kind && entry.token === trimmed)) {
      tokens.push({ kind, token: trimmed });
    }
  };
  const { text: stripped, heading } = stripMarkdownPrefix(normalizeMemoryGateText(rawLine));
  let text = stripped;

  text = blankAll(text, URL_PATTERN, (match) => push("url", match[0].replace(/[.,;:!?]+$/u, "")));
  text = blankAll(text, QUOTE_PATTERN, (match) =>
    push("quote", match[1] ?? match[2] ?? match[3] ?? match[4] ?? ""),
  );
  text = blankAll(text, PATH_PATTERN, (match) => {
    if (/\p{L}/u.test(match[0])) {
      push("path", match[0].replace(/[.,;:!?]+$/u, ""));
    }
  });
  for (const amount of collectAmounts(text)) {
    push("amount", `${amount.currency} ${amount.number}`);
  }
  const markers = CURRENCY_CLASSES.map(({ pattern }) => pattern).join("|");
  text = blankAll(
    text,
    new RegExp(
      `(?:(?:${markers})\\s?${AMOUNT_NUMBER})|(?:(?<![\\d.])${AMOUNT_NUMBER}\\s?(?:${markers}))`,
      "giu",
    ),
  );
  text = blankAll(text, LATIN_HONORIFIC_PREFIX, (match) =>
    push("honorific-name", match[1]!.replace(/['’]s$/u, "")),
  );
  text = blankAll(text, LATIN_HONORIFIC_SUFFIX, (match) => push("honorific-name", match[1]!));
  text = blankAll(text, CJK_HONORIFIC, (match) => push("cjk-name", match[1]!.replace(/・$/u, "")));
  for (const match of text.matchAll(KATAKANA_RUN)) {
    const run = match[0].replace(/^[・ー]+|[・]+$/gu, "");
    if (run.length >= 2) {
      push("cjk-name", run);
    }
  }
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    push("number", match[0].replace(/[.:/-]+$/u, ""));
  }
  if (!heading) {
    for (const match of text.matchAll(/(?<![\p{L}\p{N}_'’])\p{Lu}[\p{L}\p{M}'’-]*/gu)) {
      const word = match[0].replace(/['’]s$/u, "").replace(/[-'’]+$/u, "");
      if (word.length < 2 || CAPITALIZED_ALLOWLIST.has(word.toLowerCase())) {
        continue;
      }
      if (isSentenceStart(text, match.index ?? 0)) {
        continue;
      }
      push("proper-noun", word);
    }
  }
  return tokens;
}

type PreparedSource = { text: string; lower: string; amounts: Set<string> };

function prepareSources(sources: readonly MemoryWriteSource[]): PreparedSource {
  const text = sources.map((source) => normalizeMemoryGateText(source.text)).join("\n");
  return {
    text,
    lower: text.toLowerCase(),
    amounts: new Set(collectAmounts(text).map((entry) => `${entry.currency} ${entry.number}`)),
  };
}

function isTokenSupported(token: MemoryClaimToken, source: PreparedSource): boolean {
  switch (token.kind) {
    case "number":
      return new RegExp(`(?<!\\d)${escapeRegExp(token.token)}(?!\\d)`, "u").test(source.text);
    case "amount":
      return source.amounts.has(token.token);
    case "url":
      return source.text.includes(token.token.replace(/\/+$/u, ""));
    case "path":
    case "quote":
      return source.text.includes(token.token);
    case "cjk-name":
      return source.text.includes(token.token);
    case "proper-noun":
    case "honorific-name":
      return new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(token.token.toLowerCase())}(?![\\p{L}\\p{N}_])`,
        "u",
      ).test(source.lower);
  }
  return false;
}

/** Lines of `after` that are not carried over from `before` (multiset diff). */
function listAddedMemoryLines(
  before: string,
  after: string,
): Array<{ lineNumber: number; text: string }> {
  const remaining = new Map<string, number>();
  for (const line of before.split(/\r?\n/u)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  const added: Array<{ lineNumber: number; text: string }> = [];
  after.split(/\r?\n/u).forEach((line, index) => {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
      return;
    }
    if (line.trim() && !/^\s*(?:[-*_]{3,}|```.*|~~~.*)\s*$/u.test(line)) {
      added.push({ lineNumber: index + 1, text: line });
    }
  });
  return added;
}

function hasResolvableRef(source: MemoryWriteSource): boolean {
  const ref = source.ref;
  if (!source.text.trim()) {
    return false;
  }
  switch (ref.kind) {
    case "session-transcript":
      return ref.sessionId.trim().length > 0;
    case "file":
      return ref.path.trim().length > 0;
    case "tool-result":
      return ref.toolCallId.trim().length > 0;
    case "hook-metadata":
      return ref.label.trim().length > 0;
  }
  return false;
}

/**
 * Evaluates a memory write. Only lines added relative to `contentBefore` are
 * checked; deletions and unchanged lines never need a source. A write that adds
 * any line needs at least one resolvable source reference.
 */
export function evaluateMemoryWrite(params: {
  contentBefore: string;
  contentAfter: string;
  sources: readonly MemoryWriteSource[];
  /** Require at least one source of this kind (e.g. the session transcript). */
  requireRefKind?: MemoryWriteSourceRef["kind"];
}): MemoryWriteGateResult {
  const added = listAddedMemoryLines(params.contentBefore, params.contentAfter);
  const sources = params.sources.filter(hasResolvableRef);
  if (added.length === 0) {
    return { ok: true, checkedLines: 0, sourceRefs: sources.map((source) => source.ref) };
  }
  if (
    sources.length === 0 ||
    (params.requireRefKind && !sources.some((source) => source.ref.kind === params.requireRefKind))
  ) {
    return {
      ok: false,
      code: "missing-source",
      message: `${REJECTION_PREFIX} no resolvable source reference (session transcript, file, or tool result) accompanies this write.`,
    };
  }
  const prepared = prepareSources(sources);
  const rejections: MemoryWriteLineRejection[] = [];
  for (const line of added) {
    const missing = extractMemoryClaimTokens(line.text).filter(
      (token) => !isTokenSupported(token, prepared),
    );
    if (missing.length > 0) {
      rejections.push({
        lineNumber: line.lineNumber,
        line: line.text,
        reason: missing.some((token) => NAME_TOKEN_KINDS.has(token.kind))
          ? "unsupported-name"
          : "unsupported-claim",
        missing,
      });
    }
  }
  if (rejections.length > 0) {
    return {
      ok: false,
      code: "unsupported-lines",
      message: formatRejections(rejections),
      rejections,
    };
  }
  return { ok: true, checkedLines: added.length, sourceRefs: sources.map((source) => source.ref) };
}

function formatRejections(rejections: readonly MemoryWriteLineRejection[]): string {
  const lines = rejections.slice(0, 20).map((rejection) => {
    const missing = rejection.missing
      .map((token) => `${token.kind} ${JSON.stringify(token.token)}`)
      .join(", ");
    const why =
      rejection.reason === "unsupported-name"
        ? "names a person/entity not present in the source"
        : "contains values not present in the source";
    return `- line ${rejection.lineNumber}: ${why} (${missing}): ${JSON.stringify(rejection.line.trim().slice(0, 200))}`;
  });
  const more = rejections.length > 20 ? [`- ...and ${rejections.length - 20} more line(s)`] : [];
  return [
    `${REJECTION_PREFIX} these lines are not supported by the referenced source (lexical check: numbers, dates, amounts, URLs, paths, quotes, and names must appear in the source). Nothing was written.`,
    ...lines,
    ...more,
    "Correct the values from the source or drop the unsupported lines, then retry.",
  ].join("\n");
}

export class MemoryWriteGateError extends Error {
  readonly result: Exclude<MemoryWriteGateResult, { ok: true }>;
  readonly relativePath: string;

  constructor(relativePath: string, result: Exclude<MemoryWriteGateResult, { ok: true }>) {
    super(`${result.message}\nTarget: ${relativePath}`);
    this.name = "MemoryWriteGateError";
    this.result = result;
    this.relativePath = relativePath;
  }
}

type SourceMessage = {
  role?: unknown;
  content?: unknown;
  command?: unknown;
  output?: unknown;
  isError?: unknown;
};

function contentText(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) =>
    part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      ? [String((part as { text?: unknown }).text ?? "")]
      : [],
  );
}

/**
 * Renders the evidence portion of a session transcript: user messages,
 * successful tool results, and user-run command executions. Assistant messages
 * (prose, thinking, and tool-call arguments, which include the memory write
 * itself) and failed tool results (which echo rejected content back) are
 * excluded, so the model cannot support a claim by having asserted it.
 */
export function renderMemoryWriteSourceMessages(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as SourceMessage;
    if (message.role === "user") {
      parts.push(...contentText(message.content));
    } else if (message.role === "toolResult" && message.isError !== true) {
      parts.push(
        ...contentText(message.content).filter((text) => !text.startsWith(REJECTION_PREFIX)),
      );
    } else if (message.role === "bashExecution") {
      parts.push(String(message.command ?? ""), String(message.output ?? ""));
    }
  }
  return parts.filter(Boolean).join("\n");
}
