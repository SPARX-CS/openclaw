// Support for the f7-* tests (LINE WORKS-style text-only channel progress display).
// run.sh copies tests/*.test.ts and *.support.ts into <tree>/test/ixg-taikan/, but NOT reference/.
// The reference module is therefore loaded by absolute path: IXG_F7_REFERENCE_DIR, or (set by run.sh)
// IXG_TAIKAN_RECORD_DIR/../reference. Nothing here touches the network, a key, or a real channel.
import path from "node:path";

function referenceDir(): string {
  const explicit = process.env.IXG_F7_REFERENCE_DIR;
  if (explicit) {
    return explicit;
  }
  const out = process.env.IXG_TAIKAN_RECORD_DIR;
  if (out) {
    return path.join(out, "..", "reference");
  }
  throw new Error(
    "set IXG_F7_REFERENCE_DIR (or run through run.sh, which sets IXG_TAIKAN_RECORD_DIR)",
  );
}

type Reference = typeof import("../reference/text-channel-progress.js");
export const ref = (await import(
  /* @vite-ignore */ path.join(referenceDir(), "text-channel-progress.ts")
)) as Reference;

type BoardReference = typeof import("../reference/text-channel-progress-board.js");
export const boardRef = (await import(
  /* @vite-ignore */ path.join(referenceDir(), "text-channel-progress-board.ts")
)) as BoardReference;

export type Sent = { at: number; text: string };

/** A fake text channel: records every message the reporter sends, with the (fake) elapsed ms. */
export function createRig(
  over: Partial<Parameters<Reference["createTextProgressReporter"]>[0]> = {},
  sendImpl?: (text: string) => Promise<void>,
) {
  const t0 = Date.now();
  const sent: Sent[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const reporter = ref.createTextProgressReporter({
    send: async (text) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sent.push({ at: Date.now() - t0, text });
      try {
        await sendImpl?.(text);
      } finally {
        inFlight -= 1;
      }
    },
    ...over,
  });
  return {
    reporter,
    o: reporter.replyOptions,
    sent,
    texts: () => sent.map((s) => s.text),
    maxInFlight: () => maxInFlight,
  };
}

/** Strings that must never reach the customer, whatever the tool/args/title/error contained. */
export const LEAKS = [
  "/home/sparx",
  "customers/acme",
  "internal.example",
  "https://",
  "http://",
  "sk-live-",
  "Bearer",
  "Authorization",
  "curl ",
  "rm -rf",
  "q3-secret.xlsx",
  "token=abc",
  "C:\\Users",
];

/** Which forbidden strings (if any) appear in the texts the customer would see. Expect []. */
export function leaksIn(texts: string[]): string[] {
  return LEAKS.filter((leak) => texts.some((text) => text.includes(leak)));
}

// ---- event builders: the shapes core hands to the reply options (agent-runner-event-handler.ts mapping) ----
const LEAKY_PATH = "/home/sparx/customers/acme/請求書_2026.pdf";
const LEAKY_URL = "https://internal.example/api/v1/export?token=abc";
const LEAKY_COMMAND =
  'curl -H "Authorization: Bearer sk-live-0123456789abcdef0123456789" https://internal.example/x && rm -rf /tmp/work';

export const leaky = { path: LEAKY_PATH, url: LEAKY_URL, command: LEAKY_COMMAND };

export function toolStart(name: string, toolCallId: string, extra: Record<string, unknown> = {}) {
  return {
    toolCallId,
    name,
    phase: "start",
    args: { path: LEAKY_PATH, url: LEAKY_URL, command: LEAKY_COMMAND },
    detailMode: "explain" as const,
    ...extra,
  };
}

export function itemEvent(
  name: string,
  toolCallId: string,
  phase: "start" | "update" | "end",
  status: "running" | "completed" | "failed" | "blocked" | "skipped" | undefined,
  extra: Record<string, unknown> = {},
) {
  return {
    itemId: `tool:${toolCallId}`,
    toolCallId,
    kind: "tool",
    name,
    phase,
    ...(status ? { status } : {}),
    // title/meta are built from args by core and DO contain paths/URLs/commands (the reporter must not use them)
    title: `${name} ${LEAKY_PATH} ${LEAKY_URL} ${LEAKY_COMMAND}`,
    meta: `${LEAKY_PATH} ${LEAKY_COMMAND}`,
    commandBearing: name === "exec" || name === "bash",
    ...extra,
  };
}

export function commandOutputEnd(
  toolCallId: string,
  exitCode: number | null,
  status: string,
  name = "exec",
) {
  return {
    itemId: `command:${toolCallId}`,
    phase: "end",
    title: `command ${LEAKY_COMMAND}`,
    toolCallId,
    name,
    output: `error reading ${LEAKY_PATH} from ${LEAKY_URL}`,
    status,
    exitCode,
    durationMs: 120,
    cwd: "/home/sparx/customers/acme",
  };
}
