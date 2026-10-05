// F5 support: helpers for the tool-failure acceptance tests (pdf tool, 401 URL / path outside allowed roots).
// Everything is local: a loopback "auth wall" HTTP server (127.0.0.1 only, no external network), temp dirs,
// and the real pdf tool driven up to the point where it loads the document (the model is never reached).
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

export async function makeTempDir(prefix: string): Promise<string> {
  // Resolve symlinks (macOS-style /var -> /private/var) so path comparisons stay literal.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

export type AuthWall = {
  /** URL on the wall, e.g. url("/a.pdf"). */
  url: (pathname: string) => string;
  /** Number of HTTP requests the origin received (= fetch attempts that reached the network). */
  hitCount: () => number;
  /** Authorization headers seen (always empty today: the pdf tool never sends any). */
  authorizationHeaders: () => Array<string | undefined>;
  close: () => Promise<void>;
};

/** A document host that answers every request with HTTP 401 (needs login), like a private share link. */
export async function startAuthWall(): Promise<AuthWall> {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    );
    res.statusCode = 401;
    res.setHeader("www-authenticate", 'Bearer realm="docs"');
    res.setHeader("content-type", "text/plain");
    // Neutral body on purpose: the acceptance checks look for guidance written by OpenClaw, not echoed by the origin.
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (pathname) => `http://127.0.0.1:${port}${pathname}`,
    hitCount: () => seen.length,
    authorizationHeaders: () => [...seen],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

type PdfToolLike = {
  name?: string;
  execute: (...args: any[]) => Promise<any>;
};

/**
 * The real pdf tool (src/agents/tools/pdf-tool.ts). An explicit pdfModel keeps registration independent of
 * provider auth; the document load (where F5 failures happen) runs before any model call.
 * `tools.web.fetch.ssrfPolicy.allowPrivateNetwork` only lets the tool reach the loopback auth wall.
 */
export async function createRealPdfTool(params?: {
  workspaceDir?: string;
  fsPolicy?: { workspaceOnly?: boolean };
  /** Extra tools.web.fetch settings (e.g. headers); the pdf tool only reads tools.web.fetch.ssrfPolicy today. */
  webFetch?: Record<string, unknown>;
}): Promise<PdfToolLike> {
  const { createPdfTool } = await import("../../src/agents/tools/pdf-tool.js");
  const agentDir = await makeTempDir("f5-agent-");
  const tool = createPdfTool({
    config: {
      agents: { defaults: { pdfModel: { primary: "anthropic/claude-opus-4-6" } } },
      tools: {
        web: { fetch: { ...(params?.webFetch ?? {}), ssrfPolicy: { allowPrivateNetwork: true } } },
      },
    } as never,
    agentDir,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params?.fsPolicy ? { fsPolicy: params.fsPolicy } : {}),
  } as never);
  if (!tool) {
    throw new Error("pdf tool did not register (test setup problem, not the behaviour under test)");
  }
  return tool as unknown as PdfToolLike;
}

export type FailedCall = { error: Error; message: string; ms: number };

/** Runs one pdf call that is expected to fail; reports the thrown error and how long the model waited. */
export async function callPdfExpectFailure(tool: PdfToolLike, pdf: string): Promise<FailedCall> {
  const startedAt = performance.now();
  try {
    await tool.execute("f5-call", { prompt: "summarize", pdf }, undefined, undefined);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { error: err, message: err.message, ms: performance.now() - startedAt };
  }
  throw new Error(`expected the pdf call to fail but it resolved: ${pdf}`);
}

/** Text with the parts the origin / the caller supplied (URL, path, origin body, bare HTTP status text) removed. */
export function guidanceTextOf(message: string, echoed: string[] = []): string {
  let text = message;
  for (const piece of echoed) {
    text = text.split(piece).join("<echo>");
  }
  return text
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/;\s*body:[\s\S]*$/i, "")
    .replace(/\bUnauthorized\b/gi, "");
}

/**
 * What tells the model HOW to open an auth-walled URL: authenticated fetch into the workspace, or asking the customer
 * (attach the file / open the sharing permission). Japanese (the F5a wording) or the English credential words.
 */
export const AUTH_GUIDANCE =
  /認証|ログイン|共有設定|権限|\b(authenticat\w*|credential\w*|authori[sz]ation|bearer|api[- ]?key|token|headers?|sign[- ]?in|log[- ]?in|cookie\w*)\b/i;

/** What names the controlling setting or a concrete remedy for "path outside allowed locations". */
export const PATH_REMEDY =
  /作業場|コピー|移す|添付|\b(tools\.fs|workspaceOnly|allowed[- ]roots?|local[- ]roots?|readOnlyRoots|config(?:uration)?|setting|openclaw\.json|copy|move)\b|workspace/i;

/** Hiragana / katakana / kanji: the text is written in Japanese. */
export const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/;

// run.sh exports IXG_TAIKAN_RECORD_DIR (= <branch>/ixg-taikan-acceptance/out); without it nothing is written to a file.
const RECORD_DIR = process.env.IXG_TAIKAN_RECORD_DIR ?? "";

function recordFile(): string | undefined {
  // vitest's JSON reporter drops console output, so records also go to out/f5-records-<tree>.log when that dir exists.
  return RECORD_DIR && fsSync.existsSync(RECORD_DIR)
    ? path.join(RECORD_DIR, `f5-records-${path.basename(process.cwd())}.log`)
    : undefined;
}

export function resetRecords(): void {
  const file = recordFile();
  if (file) {
    fsSync.writeFileSync(file, "");
  }
}

export function record(label: string, value: unknown): void {
  // One line per record: multi-line texts are written as JSON strings.
  const line = `[F5-RECORD] ${label}: ${typeof value === "string" && !value.includes("\n") ? value : JSON.stringify(value)}`;
  console.log(line);
  const file = recordFile();
  if (file) {
    fsSync.appendFileSync(file, `${line}\n`);
  }
}
