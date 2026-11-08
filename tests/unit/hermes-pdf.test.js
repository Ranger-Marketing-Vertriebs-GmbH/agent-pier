import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { pdfKeyEnv } from "../../server/features/assistants/runtimes/hermes/hermes-config/pdf.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";
import { hermesPdfFallback } from "../../server/application/hermes-wiring.js";

// Read PDFs on Hermes (hermes-config/pdf.js): AgentPier's own pdf tool in the team
// plugin, which reads scanned pages too, with the model AgentPier names.
const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const connection = { url: "http://127.0.0.1:9", token: "bridge-token" };
const workspace = "/data/workspaces/a1";
const agent = (capabilities = { readPdfs: true }, extra = {}) =>
  desiredAgent({
    id: "a1",
    runtimeAgentId: "ap-a1",
    revision: 1,
    capabilities,
    ...extra,
  });
const endpoint = (input = [], apiKey = "model-key", extra = {}) => ({
  api: "openai-completions",
  baseUrl: "http://models.test/v1",
  apiKey,
  models: [{ id: "m1", input }],
  ...extra,
});
const withModel = (base, input) =>
  desiredAgent(
    { ...base, id: "a1", runtimeAgentId: "ap-a1", revision: 1 },
    { model: { provider: endpoint(input) } },
  );
const home = (built, options = {}) =>
  compileHome(built, { workspace, connection, ...options });
const tools = (built) =>
  JSON.parse(built.files["plugins/agentpier-team/tools.json"] || "{}");
const env = (built) => built.files[".env"] || "";
const visionFallback = {
  provider: endpoint(["text", "image"], "fallback-key"),
  images: true,
};

test("the pdf tool exists only while the agent may read PDFs and has the team plugin", () => {
  const reading = home(agent());
  assert.equal(tools(reading).pdf.name, "pdf");
  assert.equal(tools(reading).pdf.folder, workspace);
  assert.equal(tools(reading).pdf.maxPages, 20);
  assert.match(reading.files["plugins/agentpier-team/pdf_tool.py"], /def handler\(/);
  for (const built of [
    home(agent({ readPdfs: false })),
    compileHome(agent(), { workspace }),
    home(agent(), { workspace: undefined }),
  ]) {
    assert.equal(tools(built).pdf, undefined);
    assert.equal(built.files["plugins/agentpier-team/pdf_tool.py"], undefined);
  }
  // A restricted user's agent reads PDFs as on OpenClaw: no lock on them.
  const user = home(agent({ readPdfs: true }, { userAccess: { userId: "u" } }));
  assert.equal(tools(user).pdf.name, "pdf");
  // Hermes's hosted OCR never gets a PDF.
  assert.equal(
    readHermesConfig(reading.files["config.yaml"]).file_tools.hosted_ocr,
    false,
  );
});

test("a text-only agent reads with the owner's fallback, its key in .env alone", () => {
  const base = { capabilities: { readPdfs: true } };
  const text = home(withModel(base, ["text"]), { pdfFallback: visionFallback });
  assert.deepEqual(tools(text).pdf.fallback, {
    api: "chat",
    url: "http://models.test/v1",
    model: "m1",
    label: "m1",
    images: true,
  });
  assert.match(env(text), new RegExp(`^${pdfKeyEnv}='fallback-key'$`, "m"));
  assert.ok(!text.files["plugins/agentpier-team/tools.json"].includes("fallback-key"));
  // An agent whose own model takes images reads with it: no fallback, no key, and
  // Hermes learns the model sees images.
  const vision = home(withModel(base, ["text", "image"]), {
    pdfFallback: visionFallback,
    existing: { ".env": `${pdfKeyEnv}='old'\n` },
  });
  assert.equal(tools(vision).pdf.fallback, undefined);
  assert.ok(!env(vision).includes(pdfKeyEnv));
  assert.equal(readHermesConfig(vision.files["config.yaml"]).model.supports_vision, true);
  assert.equal(
    readHermesConfig(text.files["config.yaml"]).model.supports_vision,
    undefined,
  );
  // A key in its own header; a fallback Hermes cannot call reads nothing.
  const header = home(withModel(base, ["text"]), {
    pdfFallback: {
      provider: endpoint(["image"], "k2", {
        authHeader: false,
        headers: { "api-key": "k2" },
      }),
      images: true,
    },
  });
  assert.equal(tools(header).pdf.fallback.keyHeader, "api-key");
  const other = home(withModel(base, ["text"]), {
    pdfFallback: { provider: endpoint([], "k3", { api: "anthropic-messages" }) },
  });
  assert.equal(tools(other).pdf.fallback, undefined);
  assert.ok(!env(other).includes(pdfKeyEnv));
  // Without the apply's fallback the home keeps the key it has.
  const unnamed = home(withModel(base, ["text"]), {
    existing: { ".env": `${pdfKeyEnv}='kept'\n` },
  });
  assert.match(env(unnamed), new RegExp(`^${pdfKeyEnv}='kept'$`, "m"));
});

test("a ChatGPT fallback is reached through AgentPier's model proxy", () => {
  const modelProxy = {
    url: "http://127.0.0.1:7000",
    credentialFor: (profileId) => `apx1.${profileId}`,
  };
  const built = home(withModel({ capabilities: { readPdfs: true } }, ["text"]), {
    modelProxy,
    pdfFallback: {
      chatgpt: { profileId: "p1", modelId: "gpt-5.4", holder: "agentpier" },
      images: true,
    },
  });
  assert.deepEqual(tools(built).pdf.fallback, {
    api: "codex",
    url: "http://127.0.0.1:7000/chatgpt/codex",
    model: "gpt-5.4",
    label: "gpt-5.4",
    images: true,
  });
  assert.match(env(built), new RegExp(`^${pdfKeyEnv}='apx1\\.p1'$`, "m"));
  // A login OpenClaw still holds never reaches Hermes.
  const held = home(withModel({ capabilities: { readPdfs: true } }, ["text"]), {
    modelProxy,
    pdfFallback: {
      chatgpt: { profileId: "p1", modelId: "gpt-5.4", holder: "openclaw" },
      images: true,
    },
  });
  assert.equal(tools(held).pdf.fallback, undefined);
});

test("an apply resolves the owner's fallback; a save applies the agents that read PDFs", async () => {
  const released = [];
  const models = {
    resolve: async ({ connectionId }) => {
      if (connectionId === "gone") throw Error("provider");
      return {
        provider: endpoint(["image"]),
        release: () => released.push(connectionId),
      };
    },
    imageInput: () => true,
  };
  assert.equal(await hermesPdfFallback(models, { ready: false }), null);
  assert.deepEqual(
    await hermesPdfFallback(models, { ready: true, connectionId: "c1", modelId: "m1" }),
    { provider: endpoint(["image"]), images: true },
  );
  assert.deepEqual(released, ["c1"]);
  assert.equal(
    await hermesPdfFallback(models, { ready: true, connectionId: "gone", modelId: "m" }),
    null,
  );

  const applied = [];
  const profiles = [
    {
      id: "h1",
      runtimeAgentId: "ap-h1",
      runtime: "hermes",
      capabilities: { readPdfs: true },
    },
    { id: "h2", runtimeAgentId: "ap-h2", runtime: "hermes", capabilities: {} },
    { id: "o1", runtimeAgentId: "ap-o1", capabilities: { readPdfs: true } },
  ];
  const changes = new WebToolsChanges({
    assistants: {
      runtime: {},
      store: { listAssistants: () => profiles },
      config: { apply: async (id) => applied.push(id) },
    },
    webSearch: { resolve: () => ({}) },
    pdfModel: { preview: () => ({ ready: false }), save: () => ({ saved: true }) },
  });
  assert.deepEqual(await changes.savePdfModel({}), { saved: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ["h1"]);
});

// A stand-in for pypdfium2: pages separated by form feeds after the %PDF line, a page
// without text being a scan; render() yields an image of the scaled page size.
const fakePdfium = `
class _Image:
    def __init__(self, width, height):
        self.width, self.height = width, height
    def convert(self, mode):
        return self
    def save(self, out, format=None, quality=None):
        out.write(b"JPEG-" + str(self.width).encode())
class _Bitmap:
    def __init__(self, width, height):
        self.width, self.height = width, height
    def to_pil(self):
        return _Image(self.width, self.height)
class _Text:
    def __init__(self, text):
        self.text = text
    def get_text_bounded(self):
        return self.text
class _Page:
    def __init__(self, text):
        self.text = text
    def get_textpage(self):
        return _Text(self.text)
    def get_size(self):
        return (612.0, 792.0)
    def render(self, scale=1):
        return _Bitmap(int(612 * scale), int(792 * scale))
class PdfDocument:
    def __init__(self, path, password=None):
        data = open(path, "rb").read().decode("latin-1")
        self.pages = [_Page(t) for t in data.split("\\n", 1)[1].split("\\f")]
    def __len__(self):
        return len(self.pages)
    def __getitem__(self, index):
        return self.pages[index]
    def close(self):
        pass
`;
const runner = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
tools = {}
class Ctx:
    def register_tool(self, name, handler, **_):
        tools[name] = handler
    def register_hook(self, *_):
        pass
plugin.register(Ctx())
result = tools["pdf"](json.loads(sys.argv[2]), session_id="20261108_100000_abcd")
print(result if isinstance(result, str) else json.dumps(result))
`;
const invoice = "Invoice 4711, total 99 EUR. ".repeat(10);

// The compiled plugin in Python with the stand-in PDFium, against a local server that
// answers as AgentPier's bridge (`guard`) and as the fallback model (`model`).
async function readPdf(t, { guard, fallback, args, model = () => ({}) }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-pdf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    seen.push({ url: req.url, headers: req.headers, body: parsed });
    if (req.url === "/hermes-guard") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(guard));
    }
    const answer = model(req.url);
    res.writeHead(200, { "content-type": answer.type || "application/json" });
    res.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const folder = path.join(dir, "workspace");
  fs.mkdirSync(path.join(folder, "docs"), { recursive: true });
  fs.writeFileSync(path.join(folder, "docs/scan.pdf"), `%PDF-1.4\n${invoice}\f`);
  fs.mkdirSync(path.join(dir, "site/pypdfium2"), { recursive: true });
  fs.writeFileSync(path.join(dir, "site/pypdfium2/__init__.py"), fakePdfium);
  const built = compileHome(
    desiredAgent(
      {
        id: "a1",
        runtimeAgentId: "ap-a1",
        revision: 1,
        capabilities: { readPdfs: true },
      },
      { model: { provider: endpoint(["text"]) } },
    ),
    {
      workspace: folder,
      connection: { url, token: "bridge-token" },
      pdfFallback: fallback && { ...fallback, url },
      modelProxy: { url, credentialFor: () => "apx1.proxy" },
    },
  );
  for (const [file, text] of Object.entries(built.files)) {
    if (!file.startsWith("plugins/agentpier-team/")) continue;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  // A fallback endpoint at the local server.
  const settings = path.join(dir, "plugins/agentpier-team/tools.json");
  const parsed = JSON.parse(fs.readFileSync(settings, "utf8"));
  if (parsed.pdf.fallback?.api === "chat") parsed.pdf.fallback.url = `${url}/v1`;
  fs.writeFileSync(settings, JSON.stringify(parsed));
  const { stdout } = await promisify(execFile)(
    python,
    [
      "-c",
      runner,
      path.join(dir, "plugins/agentpier-team/__init__.py"),
      JSON.stringify(args),
    ],
    {
      env: {
        PATH: process.env.PATH,
        PYTHONPATH: path.join(dir, "site"),
        [pdfKeyEnv]: "fallback-key",
      },
    },
  );
  return { result: JSON.parse(stdout), seen };
}

const skip = { skip: !python && "python3 is not installed" };

test(
  "an agent whose model sees images gets the text and the scanned page",
  skip,
  async (t) => {
    const { result, seen } = await readPdf(t, {
      guard: { allow: true, reader: "own" },
      args: { pdf: "docs/scan.pdf", prompt: "What is the total?" },
    });
    assert.equal(result._multimodal, true);
    const [text, image] = result.content;
    assert.match(text.text, /^Request: What is the total\?/);
    assert.match(text.text, /--- Page 1 ---\nInvoice 4711/);
    assert.match(text.text, /--- Page 2 ---\n\[This page has little or no text/);
    assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(result.content.length, 2, "only the page without text as an image");
    assert.match(result.text_summary, /could not be shown here/);
    // The bridge judged the call for its chat.
    assert.equal(seen[0].url, "/hermes-guard");
    assert.equal(seen[0].body.toolName, "pdf");
    assert.equal(seen[0].body.sessionKey, "agent:ap-a1:hermes:20261108_100000_abcd");
    assert.deepEqual(seen[0].body.args, {
      pdf: "docs/scan.pdf",
      prompt: "What is the total?",
    });
  },
);

test(
  "a text-only agent's PDF goes to the owner's fallback model alone",
  skip,
  async (t) => {
    const { result, seen } = await readPdf(t, {
      guard: { allow: true, reader: "fallback" },
      fallback: { provider: endpoint(["image"], "fallback-key"), images: true },
      args: { pdfs: ["docs/scan.pdf"], prompt: "Total?" },
      model: () => ({
        body: JSON.stringify({
          choices: [{ message: { content: "The total is 99 EUR." } }],
        }),
      }),
    });
    assert.deepEqual(result, { text: "The total is 99 EUR.", model: "m1" });
    const call = seen.find((entry) => entry.url === "/v1/chat/completions");
    assert.equal(call.headers.authorization, "Bearer fallback-key");
    assert.equal(call.body.model, "m1");
    const [text, image] = call.body.messages[0].content;
    assert.match(text.text, /^Total\?\n\nPDF docs\/scan\.pdf: 2 pages/);
    assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(seen.length, 2, "the bridge, then the fallback; nothing else");
  },
);

test("a ChatGPT fallback reads through the proxy's Responses stream", skip, async (t) => {
  const events = [
    { type: "response.output_text.delta", delta: "Total: " },
    { type: "response.output_text.delta", delta: "99 EUR" },
    { type: "response.completed", response: { status: "completed" } },
  ];
  const { result, seen } = await readPdf(t, {
    guard: { allow: true, reader: "fallback" },
    fallback: {
      chatgpt: { profileId: "p1", modelId: "gpt-5.4", holder: "agentpier" },
      images: true,
    },
    args: { pdf: "docs/scan.pdf" },
    model: () => ({
      type: "text/event-stream",
      body: events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(""),
    }),
  });
  assert.deepEqual(result, { text: "Total: 99 EUR", model: "gpt-5.4" });
  const call = seen.find((entry) => entry.url === "/chatgpt/codex/responses");
  assert.equal(call.headers.authorization, "Bearer fallback-key");
  assert.equal(call.body.stream, true);
  assert.equal(call.body.store, false);
  const parts = call.body.input[0].content;
  assert.deepEqual(
    parts.map((part) => part.type),
    ["input_text", "input_image"],
  );
  assert.match(parts[0].text, /^Analyze this PDF document\./);
});

test(
  "without a model that sees images the agent gets the text, and is told what it missed",
  skip,
  async (t) => {
    const { result, seen } = await readPdf(t, {
      guard: { allow: true, reader: "text" },
      args: { pdf: "docs/scan.pdf", pages: "1-2" },
    });
    assert.match(result.text, /Invoice 4711/);
    assert.match(result.note, /were not read: docs\/scan\.pdf page 2\./);
    assert.equal(seen.length, 1);
    // A refusal reaches the agent as AgentPier words it; no file is read.
    const refused = await readPdf(t, {
      guard: { allow: false, message: "This agent may not read PDFs." },
      args: { pdf: "docs/scan.pdf" },
    });
    assert.deepEqual(refused.result, { error: "This agent may not read PDFs." });
    // Paths outside its folder stay closed even if the bridge were wrong.
    const outside = await readPdf(t, {
      guard: { allow: true, reader: "text" },
      args: { pdf: "../../etc/hosts" },
    });
    assert.match(outside.result.error, /files in your workspace/);
  },
);
