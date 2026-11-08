import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";

// Read PDFs on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME), as OpenClaw
// reads them: the agent's own model (the fake model, text only) cannot see images,
// so AgentPier's pdf tool reads the PDF with PDFium from the installation
// (hermes-pdfium.js), asks AgentPier's guard, and sends the page text and the
// scanned page's image to the owner's PDF fallback model (a second connection of
// the fake model that takes images). Its answer reaches the agent as the tool result.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };

// A two-page PDF: a text page, and a page that is only an image (a scan).
function scannedPdf() {
  const text = "BT /F1 24 Tf 72 700 Td (Invoice 4711 total 99 EUR) Tj ET";
  const image = zlib.deflateSync(Buffer.alloc(60 * 40 * 3, 0xc8));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 8 0 R >>",
    [
      `<< /Type /XObject /Subtype /Image /Width 60 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
      image,
      "\nendstream",
    ],
    "<< /Length 34 >>\nstream\nq 400 0 0 266 100 400 cm /Im1 Do Q\nendstream",
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  let size = parts[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(size);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      ...[body].flat().map((part) => Buffer.from(part)),
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(chunk);
    size += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
  ].join("");
  return Buffer.concat([...parts, Buffer.from(xref)]);
}

test(
  "Hermes contract: a text-only agent reads a scanned PDF with the owner's fallback model",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { f, fleet } = app;
    // The owner's PDF fallback: a model of the fake endpoint that takes images.
    const vision = f.application.providerConnections.create({
      name: "Fake vision",
      providerId: "endpoint",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: model.baseUrl,
        anthropicBaseUrl: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        authHeader: null,
        models: [
          {
            modelId: "fake-vision",
            label: "Fake vision",
            contextTokens: 128000,
            outputTokens: 4096,
            images: true,
            source: "manual",
            contextEdited: false,
          },
        ],
      },
      apiKey: "pdf-fallback-key",
    });
    const saved = await json(
      await f.request("/api/assistant-pdf-model", {
        method: "PUT",
        body: { revision: 0, connectionId: vision.id, modelId: "fake-vision" },
      }),
    );
    assert.equal(saved.ready, true);

    const created = await app.createAgent({ name: "Hermes reader", shell: "off" });
    const agent = await json(
      await f.request(`/api/assistants/${created.id}`, {
        method: "PATCH",
        body: {
          revision: created.revision,
          capabilities: { ...created.capabilities, readPdfs: true },
          confirmRestart: true,
        },
      }),
    );
    const paths = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    const read = (name) => fs.readFileSync(path.join(paths.hermesHome, name), "utf8");
    const settings = () =>
      JSON.parse(read("plugins/agentpier-team/tools.json")).pdf?.fallback;
    await eventually(() => !!settings(), 60000, "the pdf tool with its fallback");
    await app.ready(agent);
    assert.equal(settings().model, "fake-vision");
    assert.match(read(".env"), /^AUXILIARY_AGENTPIER_PDF_API_KEY='pdf-fallback-key'$/m);
    assert.ok(!read("plugins/agentpier-team/tools.json").includes("pdf-fallback-key"));

    fs.mkdirSync(path.join(paths.workspace, "docs"), { recursive: true });
    fs.writeFileSync(path.join(paths.workspace, "docs/scan.pdf"), scannedPdf());
    const chat = await app.chat(agent);
    await chat.send(
      "pdf",
      `Read it.\nCALL: pdf ${JSON.stringify({ pdf: "docs/scan.pdf", prompt: "What is the total?" })}`,
    );
    const done = await chat.reply("TOOL_DONE");
    assert.match(done.text, /"model": "fake-vision"/);
    // The fallback got the text layer and the scanned page's image, with its own key.
    const call = model.requests.find((r) => r.body?.model === "fake-vision");
    assert.ok(call, "a request to the fallback model");
    assert.equal(call.headers.authorization, "Bearer pdf-fallback-key");
    const [text, ...images] = call.body.messages[0].content;
    assert.match(text.text, /^What is the total\?/);
    assert.match(text.text, /Invoice 4711 total 99 EUR/);
    assert.ok(images.length >= 1);
    for (const image of images)
      assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
    // The agent's own model never saw a page image.
    const own = model.requests.filter((r) => r.body?.model === "fake-1");
    assert.ok(!JSON.stringify(own.map((r) => r.body.messages)).includes("image/jpeg"));

    // A file outside its folder is refused before anything is read.
    const before = model.requests.length;
    await eventually(
      async () => {
        const sent = await f.request(
          `/api/assistant-conversations/${chat.chat.id}/messages`,
          {
            method: "POST",
            body: {
              clientRequestId: "outside",
              text: `CALL: pdf ${JSON.stringify({ pdf: "/etc/hosts" })}`,
            },
          },
        );
        if (sent.status === 409) return false;
        assert.ok([200, 201, 202].includes(sent.status), await sent.text());
        return true;
      },
      120000,
      "the first turn to end",
    );
    const refused = await chat.reply(/TOOL_DONE.*workspace/s);
    assert.match(refused.text, /paths to files in your workspace/);
    assert.ok(
      !model.requests.slice(before).some((r) => r.body?.model === "fake-vision"),
      "no fallback request for the refused call",
    );

    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: path.dirname(paths.hermesHome) }), []);
  },
);
