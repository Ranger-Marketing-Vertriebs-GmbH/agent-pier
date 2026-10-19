import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PdfModelSettings } from "../../server/features/assistants/pdf-model-settings.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";
import { webToolsSnapshot } from "../../server/features/assistants/openclaw-config/web-tools.js";

const search = { provider: "duckduckgo", requiresPlugin: true };
const searchPlugins = { duckduckgo: { id: "duckduckgo", directory: "/rt/ddg" } };
const browser = { available: false };
const reader = {
  id: "a1",
  name: "Reader",
  runtimeAgentId: "ap-a1",
  capabilities: { readPdfs: true },
};
const plain = { id: "a2", name: "Plain", runtimeAgentId: "ap-a2", capabilities: {} };

// A running Gateway started from the current settings; saves compare with it.
function fixture(t, { profiles, documentExtract = true }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-pdf-restart-"));
  const models = {
    listCapabilities: () => [{ id: "router", available: true }],
    imageInput: () => true,
  };
  const pdfModel = new PdfModelSettings({ dataDir, models });
  t.after(() => {
    pdfModel.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const calls = [];
  const runtime = { client: { ready: true } };
  const start = () => {
    runtime.webTools = webToolsSnapshot({
      profiles,
      webTools: {
        search,
        browser,
        searchPlugins,
        pdf: pdfModel.resolve(),
        documentExtract,
      },
    });
  };
  start();
  const changes = new WebToolsChanges({
    assistants: { runtime, store: { listAssistants: () => profiles } },
    webSearch: { resolve: () => search },
    detect: () => browser,
    pdfModel,
    synchronization: {
      restartGateway: async (operation) => {
        calls.push("restart");
        const result = await operation();
        start();
        return result;
      },
    },
  });
  return { changes, pdfModel, calls };
}

const choose = (revision, modelId = "vision") => ({
  revision,
  connectionId: "router",
  modelId,
});

test("choosing a PDF model while no agent reads PDFs applies without a restart", async (t) => {
  const { changes, calls } = fixture(t, { profiles: [plain] });
  const saved = await changes.savePdfModel(choose(0));
  assert.equal(saved.ready, true);
  assert.deepEqual(calls, []);
});

test("for agents that read PDFs a new model asks to restart first", async (t) => {
  const { changes, pdfModel, calls } = fixture(t, { profiles: [reader, plain] });
  await assert.rejects(changes.savePdfModel(choose(0)), {
    code: "ASSISTANT_RESTART_REQUIRED",
    affected: {
      agents: [reader, plain].map(({ id, name }) => ({ id, name })),
      teamMembers: 0,
    },
  });
  // Nothing is stored before the owner confirms.
  assert.equal(pdfModel.get().revision, 0);
  const saved = await changes.savePdfModel(choose(0), { confirmed: true });
  assert.equal(saved.modelId, "vision");
  assert.deepEqual(calls, ["restart"]);
  // The same choice again compiles the same sections.
  await changes.savePdfModel(choose(1));
  assert.deepEqual(calls, ["restart"]);
  // Removing the model withdraws the tool: a restart again.
  await assert.rejects(
    changes.savePdfModel({ revision: 2, connectionId: null, modelId: null }),
    { code: "ASSISTANT_RESTART_REQUIRED" },
  );
});

test("a runtime without PDF extraction never restarts for the PDF model", async (t) => {
  const { changes, calls } = fixture(t, {
    profiles: [reader],
    documentExtract: false,
  });
  await changes.savePdfModel(choose(0));
  assert.deepEqual(calls, []);
});
