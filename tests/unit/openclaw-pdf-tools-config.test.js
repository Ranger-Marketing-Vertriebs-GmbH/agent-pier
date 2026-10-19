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
  webToolsSignature,
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
  // Without the owner's PDF model the tool is withheld, as for a missing browser.
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

test("a chosen PDF model makes the capability available", () => {
  assert.equal(webToolsAvailability(webTools(chosen)).readPdfs, true);
  assert.equal(webToolsAvailability(webTools({ ready: false })).readPdfs, false);
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

test("no model, or no agent reading PDFs, compiles neither", () => {
  for (const [profiles, pdf] of [
    [[reader], { ready: false }],
    [[plain], chosen],
    [[reader], undefined],
  ]) {
    const config = compile(profiles, webTools(pdf));
    assert.equal(config.tools.allow.includes("pdf"), false);
    assert.equal(config.plugins.allow.includes("document-extract"), false);
    assert.equal(
      webToolsSections({ profiles, webTools: webTools(pdf), port: 0 }).pdf,
      undefined,
    );
  }
  // A PDF model an earlier start or a restored file holds does not survive.
  const stale = compile([plain], webTools(chosen), { pdfModel: "x/old" });
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

test("another PDF model changes what a start compiles only while used", () => {
  const other = { ...chosen, modelId: "vision-2" };
  assert.notEqual(
    webToolsSignature({ profiles: [reader], webTools: webTools(chosen) }),
    webToolsSignature({ profiles: [reader], webTools: webTools(other) }),
  );
  assert.notEqual(
    webToolsSignature({ profiles: [reader], webTools: webTools(chosen) }),
    webToolsSignature({ profiles: [reader], webTools: webTools({ ready: false }) }),
  );
  assert.equal(
    webToolsSignature({ profiles: [plain], webTools: webTools(chosen) }),
    webToolsSignature({ profiles: [plain], webTools: webTools(other) }),
  );
});

test("the tool guard keeps pdf calls on workspace files and the owner's model", () => {
  const call = (params) => pdfCall({ toolName: "pdf", params });
  assert.equal(call({ pdf: "attachments/report.pdf" }), undefined);
  assert.equal(call({ pdfs: ["a.pdf", "docs/b.pdf"], prompt: "Compare" }), undefined);
  assert.equal(call({ pdf: "a.pdf", pages: "1-3" }), undefined);
  const model = { block: true, blockReason: pdfRefusals.model };
  assert.deepEqual(call({ pdf: "a.pdf", model: "openai/gpt-5.4-mini" }), model);
  assert.deepEqual(call({ pdf: "a.pdf", model: "" }), model);
  const reference = { block: true, blockReason: pdfRefusals.reference };
  for (const params of [
    { pdf: "https://example.com/a.pdf" },
    { pdf: " HTTP://example.com/a.pdf" },
    { pdfs: ["a.pdf", "file:///etc/hosts"] },
    { pdfs: ["media://inbound/x"] },
    { pdf: 7 },
    { pdfs: "a.pdf" },
    { pdfs: [null] },
  ])
    assert.deepEqual(call(params), reference);
});
