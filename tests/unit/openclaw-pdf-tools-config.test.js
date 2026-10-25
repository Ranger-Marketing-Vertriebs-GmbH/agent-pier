import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import {
  hasDocumentExtract,
  webToolsAvailability,
  webToolsSections,
  webToolsSignatures,
} from "../../server/features/assistants/openclaw-config/web-tools.js";
import {
  capabilityKeys,
  guardGatedTools,
  personalCapabilities,
  profileTools,
} from "../../server/features/assistants/native-capabilities.js";
import { isLockedPath } from "../../server/features/assistants/openclaw-config/locked-core.js";
import { applyOverrides } from "../../server/features/assistants/openclaw-config/overrides.js";
import { guardNeeded } from "../../server/features/assistants/write-guard-wait.js";
import {
  pdfCall,
  pdfRefusals,
} from "../../server/features/assistants/team-plugin/tool-guard.js";

const paths = { workspaces: "/data/workspaces", logs: "/data/logs" };
const reader = { id: "a1", runtimeAgentId: "ap-a1", capabilities: { readPdfs: true } };
const plain = { id: "a2", runtimeAgentId: "ap-a2", capabilities: { documents: true } };
const member = {
  id: "m1",
  runtimeAgentId: "ap-m1",
  teamMemberId: "t1",
  lifetime: "task",
  inherited: { capabilities: { readPdfs: true }, skills: [], shell: "off", ssh: false },
};
const chosen = { ready: true, connectionId: "c1", modelId: "vision-1" };
const webTools = (pdf, documentExtract = true) => ({
  search: { provider: "duckduckgo", unavailable: true },
  browser: { available: false },
  searchPlugins: {},
  images: { ready: false },
  pdf,
  documentExtract,
});
function compile(profiles, tools, defaults = {}) {
  return compileOpenClawConfig({
    existing: {
      agents: {
        defaults,
        entries: Object.fromEntries(
          profiles.map((p) => [p.runtimeAgentId, { id: p.runtimeAgentId }]),
        ),
      },
    },
    paths,
    port: 20000,
    token: "gateway-token",
    teams: {
      directory: "/private/plugin",
      connection: { url: "http://127.0.0.1:1235", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles,
    },
    webTools: tools,
  });
}

test("reading PDFs is a capability of its own, off by default", () => {
  assert.ok(capabilityKeys.includes("readPdfs"));
  assert.equal(personalCapabilities({ capabilities: {} }).readPdfs, false);
  assert.equal(personalCapabilities(plain).readPdfs, false);
  // Read images grants only view_image, never pdf.
  const images = profileTools(plain, true, true, true, { readPdfs: true });
  assert.ok(images.includes("view_image"));
  assert.equal(images.includes("pdf"), false);
  assert.ok(profileTools(reader, true, true, true, { readPdfs: true }).includes("pdf"));
  // Without PDF extraction in the runtime the tool is withheld, as for a missing browser.
  for (const available of [{ readPdfs: false }, {}])
    assert.equal(
      profileTools(reader, true, true, true, available).includes("pdf"),
      available.readPdfs === false ? false : true,
    );
  // Like image creation it waits for the proven tool guard, which checks every call.
  assert.ok(guardGatedTools.includes("pdf"));
  assert.equal(
    profileTools(reader, true, true, false, { readPdfs: true }).includes("pdf"),
    false,
  );
  assert.equal(guardNeeded(reader), true);
  // A member reads PDFs only as its lead's grant.
  assert.ok(profileTools(member, true, true, true, { readPdfs: true }).includes("pdf"));
});

test("reading PDFs needs PDF extraction, not a PDF model", () => {
  assert.equal(webToolsAvailability(webTools(chosen)).readPdfs, true);
  // Agents read with their own model; the owner's fallback is optional.
  assert.equal(webToolsAvailability(webTools({ ready: false })).readPdfs, true);
  assert.equal(webToolsAvailability(webTools(undefined)).readPdfs, true);
  assert.equal(webToolsAvailability({}).readPdfs, false);
  // A runtime without OpenClaw's PDF extraction plugin (a rollback) cannot read PDFs.
  assert.equal(webToolsAvailability(webTools(chosen, false)).readPdfs, false);
});

test("PDF extraction is detected in the runtime's bundled plugins", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entryPath = path.join(root, "openclaw.mjs");
  assert.equal(hasDocumentExtract({ entryPath }), false);
  assert.equal(hasDocumentExtract({}), false);
  const plugin = path.join(root, "dist", "extensions", "document-extract");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "openclaw.plugin.json"), "{}");
  assert.equal(hasDocumentExtract({ entryPath }), true);
});

test("an agent that reads PDFs compiles pdf and the model ids, never a model", () => {
  const config = compile([reader, plain], webTools(chosen));
  assert.ok(config.tools.allow.includes("pdf"));
  // The restrictive plugin allow list admits the bundled extraction plugin.
  assert.ok(config.plugins.allow.includes("document-extract"));
  // The provider preparation writes agents.defaults.pdfModel with the provider.
  assert.equal(config.agents.defaults.pdfModel, undefined);
  assert.deepEqual(
    webToolsSections({ profiles: [reader], webTools: webTools(chosen), port: 0 }).pdf,
    { connectionId: "c1", modelId: "vision-1" },
  );
  // Fresh starts have no proven guard: no entry holds pdf yet.
  for (const id of ["ap-a1", "ap-a2"])
    assert.equal(config.agents.entries[id].tools.allow.includes("pdf"), false);
});

test("pdf is compiled before any agent reads PDFs, with or without a fallback", () => {
  const unused = compile([plain], webTools(chosen));
  assert.ok(unused.tools.allow.includes("pdf"));
  assert.ok(unused.plugins.allow.includes("document-extract"));
  assert.equal(unused.agents.entries["ap-a2"].tools.allow.includes("pdf"), false);
  for (const pdf of [{ ready: false }, undefined]) {
    const config = compile([reader], webTools(pdf));
    assert.ok(config.tools.allow.includes("pdf"));
    assert.ok(config.plugins.allow.includes("document-extract"));
    // No fallback ids: the provider preparation compiles a placeholder.
    assert.deepEqual(
      webToolsSections({ profiles: [reader], webTools: webTools(pdf), port: 0 }).pdf,
      {},
    );
  }
  // Without PDF extraction nothing of it is compiled.
  const old = compile([reader], webTools(chosen, false));
  assert.equal(old.tools.allow.includes("pdf"), false);
  assert.equal(old.plugins.allow.includes("document-extract"), false);
  // A PDF model an earlier start or a restored file holds does not survive.
  const stale = compile([plain], webTools({ ready: false }), { pdfModel: "x/old" });
  assert.equal(stale.agents.defaults.pdfModel, undefined);
});

test("the owner cannot set the PDF model through advanced settings", () => {
  assert.equal(isLockedPath("agents.defaults.pdfModel"), true);
  assert.equal(isLockedPath("agents.defaults.pdfModel.primary"), true);
  assert.throws(() =>
    applyOverrides({ agents: { defaults: {} } }, [
      { path: "agents.defaults.pdfModel", value: "x/y" },
    ]),
  );
});

test("another PDF model changes only the PDF section's signature", () => {
  const other = { ...chosen, modelId: "vision-2" };
  const sign = (pdf) => webToolsSignatures({ webTools: webTools(pdf) });
  assert.notEqual(sign(chosen).readPdfs, sign(other).readPdfs);
  assert.notEqual(sign(chosen).readPdfs, sign({ ready: false }).readPdfs);
  assert.deepEqual(
    { ...sign(chosen), readPdfs: null },
    { ...sign(other), readPdfs: null },
  );
});

test("the tool guard keeps pdf calls on workspace files and names their model", async () => {
  const asked = [];
  const bridge = (answer) => async (endpoint, body) => {
    asked.push({ endpoint, body });
    return answer === null
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => answer };
  };
  const ctx = { agentId: "ap-a1", sessionKey: "agent:ap-a1:main" };
  const own = bridge({ allow: true, model: "ap-c1-x/vision-1" });
  const call = (params, answer = own) =>
    pdfCall({ toolName: "pdf", params }, ctx, answer);
  assert.deepEqual(await call({ pdf: "attachments/report.pdf" }), {
    params: { pdf: "attachments/report.pdf", model: "ap-c1-x/vision-1" },
  });
  assert.deepEqual(asked.at(-1), {
    endpoint: "/pdf-policy",
    body: { agentId: "ap-a1", sessionKey: "agent:ap-a1:main" },
  });
  assert.deepEqual(await call({ pdfs: ["a.pdf", "docs/b.pdf"], prompt: "Compare" }), {
    params: {
      pdfs: ["a.pdf", "docs/b.pdf"],
      prompt: "Compare",
      model: "ap-c1-x/vision-1",
    },
  });
  // A model the agent names is replaced, never used.
  for (const model of ["openai/gpt-5.4-mini", "", 7])
    assert.equal((await call({ pdf: "a.pdf", model })).params.model, "ap-c1-x/vision-1");
  // Fails closed: no answer, a refusal or an answer without a model.
  const unavailable = { block: true, blockReason: pdfRefusals.unavailable };
  assert.deepEqual(await call({ pdf: "a.pdf" }, bridge(null)), unavailable);
  assert.deepEqual(
    await call({ pdf: "a.pdf" }, async () => {
      throw Error("down");
    }),
    unavailable,
  );
  assert.deepEqual(await call({ pdf: "a.pdf" }, bridge({ allow: true })), unavailable);
  assert.deepEqual(
    await call({ pdf: "a.pdf" }, bridge({ allow: true, model: "" })),
    unavailable,
  );
  assert.deepEqual(
    await call({ pdf: "a.pdf" }, bridge({ allow: false, reason: "notGranted" })),
    { block: true, blockReason: pdfRefusals.notGranted },
  );
  assert.deepEqual(
    await call({ pdf: "a.pdf" }, bridge({ allow: false, reason: "constructor" })),
    unavailable,
  );
  const reference = { block: true, blockReason: pdfRefusals.reference };
  const before = asked.length;
  for (const params of [
    { pdf: "https://example.com/a.pdf" },
    { pdf: " HTTP://example.com/a.pdf" },
    { pdfs: ["a.pdf", "file:///etc/hosts"] },
    { pdfs: ["media://inbound/x"] },
    { pdf: 7 },
    { pdfs: "a.pdf" },
    { pdfs: [null] },
  ])
    assert.deepEqual(await call(params), reference);
  // A refused reference never reaches AgentPier.
  assert.equal(asked.length, before);
});
