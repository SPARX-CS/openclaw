import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakePdf,
  fakePng,
  fileEvent,
  imageEvent,
  startLineFlow,
  textEvent,
  waitFor,
  type LineFlow,
} from "./c2-line-flow.support.js";

let flow: LineFlow | undefined;
afterEach(async () => {
  await flow?.cleanup();
  flow = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("probe", () => {
  it("text", async () => {
    flow = await startLineFlow();
    const res = await flow.post([textEvent({ text: "こんにちは" })]);
    console.log("RES", res.status, JSON.stringify(res.headers), res.body, res.durationMs);
    console.log("ERRS0", flow.runtimeErrors, flow.runtimeLogs);
    await waitFor(() => flow!.reached.length > 0, { what: "turn" });
    console.log(
      "REACHED",
      JSON.stringify(flow.reached[0], (k, v) => (k === "ctx" ? Object.keys(v) : v)),
    );
    console.log("ERRS", flow.runtimeErrors);
    console.log(
      "FETCH",
      flow.fetchStub.calls.map((c) => c.method + " " + c.url),
    );
  });
  it.skip("pdf + image", async () => {
    flow = await startLineFlow();
    const pdf = textEvent({ text: "x" });
    const f = fileEvent({ fileName: "見積書_2026.pdf", fileSize: 2_621_440, messageId: "pdf1" });
    const i = imageEvent({ messageId: "img1" });
    flow.media.set("pdf1", { bytes: fakePdf(2_621_440), contentType: "application/pdf" });
    flow.media.set("img1", { bytes: fakePng(), contentType: "image/png" });
    const r1 = await flow.post([f]);
    const r2 = await flow.post([i]);
    console.log("RES", r1.status, r2.status);
    await waitFor(() => flow!.reached.length > 1, { what: "turns" });
    for (const r of flow.reached) console.log("REACHED", JSON.stringify({ ...r, ctx: undefined }));
    console.log("CTXKEYS", Object.keys(flow.reached[0]!.ctx));
    console.log("ERRS", flow.runtimeErrors);
    void pdf;
  });
});
