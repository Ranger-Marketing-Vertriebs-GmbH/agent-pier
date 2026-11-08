import test from "node:test";
import assert from "node:assert/strict";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { pdfKeyEnv } from "../../server/features/assistants/runtimes/hermes/hermes-config/pdf.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";
import { hermesPdfFallback } from "../../server/application/hermes-wiring.js";

// Read PDFs on Hermes (hermes-config/pdf.js): AgentPier's own pdf tool in the team
// plugin, which reads scanned pages too, with the model AgentPier names.
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
  id: "fb-1",
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
    id: "fb-1",
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
    imageInput: ({ connectionId }) => connectionId !== "text",
  };
  const textOwn = { connectionId: "text", modelId: "t" };
  assert.equal(await hermesPdfFallback(models, { ready: false }, textOwn), null);
  assert.deepEqual(
    await hermesPdfFallback(
      models,
      { ready: true, connectionId: "c1", modelId: "m1" },
      textOwn,
    ),
    { provider: endpoint(["image"]), images: true, id: "c1\nm1" },
  );
  // An agent whose own model takes images (also an OpenRouter one, which only the
  // catalog knows) gets no fallback and no key in its home.
  assert.equal(
    await hermesPdfFallback(
      models,
      { ready: true, connectionId: "c1", modelId: "m1" },
      { connectionId: "openrouter-1", modelId: "vision" },
    ),
    null,
  );
  assert.deepEqual(released, ["c1"]);
  assert.equal(
    await hermesPdfFallback(
      models,
      { ready: true, connectionId: "gone", modelId: "m" },
      textOwn,
    ),
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
