import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { pdfKeyEnv } from "../../server/features/assistants/runtimes/hermes/hermes-config/pdf.js";

// The compiled pdf tool of a Hermes agent (hermes-config/pdf-tool.py) run in Python
// with a stand-in for pypdfium2, against a local server that answers as AgentPier's
// bridge and as the fallback model.

export const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

// A stand-in for pypdfium2: pages separated by form feeds after the %PDF line, a page
// without text being a scan; render() yields an image of the scaled page size. A
// page "SLOW" sleeps, a page "CRASH" ends the process, a PDF with "LOCKED" opens only
// with the password "pw".
const fakePdfium = `
import os, time
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
        if self.text == "SLOW":
            time.sleep(30)
        if self.text == "CRASH":
            os.abort()
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
    def __init__(self, data, password=None):
        text = data.decode("latin-1")
        if "LOCKED" in text and password != "pw":
            raise Exception("password")
        self.pages = [_Page(t) for t in text.split("\\n", 1)[1].split("\\f")]
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
export const invoice = "Invoice 4711, total 99 EUR. ".repeat(10);
const endpoint = (input, apiKey = "model-key") => ({
  api: "openai-completions",
  baseUrl: "http://models.test/v1",
  apiKey,
  models: [{ id: "m1", input }],
});
export const chatFallback = {
  provider: endpoint(["image"], "fallback-key"),
  images: true,
  id: "fb-1",
};

/** A local HTTP server for the test, closed after it; resolves its base URL. */
export const listen = async (t, handle) => {
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};

/**
 * Calls the pdf tool with `args`. `guard`: the bridge's answer; `fallback`: the
 * owner's fallback as an apply resolves it; `model(url)`: `{ status, headers, type,
 * body }` the fallback answers; `files`: PDFs of the agent's folder by relative path
 * (default docs/scan.pdf, a text page and a scan); `settings`: tools.json pdf fields
 * to change. Resolves `{ result, seen }`, `seen` the requests the server got.
 */
export async function readPdf(
  t,
  { guard, fallback, args, model = () => ({}), files, settings = {} },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-pdf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "null") });
    if (req.url === "/hermes-guard") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(guard));
    }
    const answer = model(req.url);
    res.writeHead(answer.status || 200, {
      "content-type": answer.type || "application/json",
      ...answer.headers,
    });
    res.end(answer.body);
  });
  const folder = path.join(dir, "workspace");
  for (const [name, content] of Object.entries(
    files || { "docs/scan.pdf": `%PDF-1.4\n${invoice}\f` },
  )) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
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
      pdfFallback: fallback,
      modelProxy: { url, credentialFor: () => "apx1.proxy" },
    },
  );
  for (const [file, text] of Object.entries(built.files)) {
    if (!file.startsWith("plugins/agentpier-team/")) continue;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  // The fallback endpoint at the local server, and the test's limits.
  const file = path.join(dir, "plugins/agentpier-team/tools.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.pdf.fallback?.api === "chat") parsed.pdf.fallback.url = `${url}/v1`;
  Object.assign(parsed.pdf, settings);
  fs.writeFileSync(file, JSON.stringify(parsed));
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
