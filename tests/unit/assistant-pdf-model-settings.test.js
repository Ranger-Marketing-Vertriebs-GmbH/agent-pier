import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PdfModelSettings } from "../../server/features/assistants/pdf-model-settings.js";

// The connections and accounts agents choose from (AssistantModels), as data.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-model-"));
  const listed = [
    { id: "router", providerId: "openrouter", available: true },
    { id: "keyless", providerId: "openrouter", available: false },
    {
      id: "openclaw:abc",
      providerId: "openai-chatgpt",
      available: false,
      signedIn: true,
    },
    { id: "openclaw:off", providerId: "openai-chatgpt", available: false },
  ];
  const vision = new Set(["router/vision", "keyless/vision", "openclaw:abc/gpt-5.5"]);
  const models = {
    listCapabilities: () => listed,
    imageInput: ({ connectionId, modelId }) =>
      connectionId.startsWith("openclaw:") || vision.has(`${connectionId}/${modelId}`),
  };
  const settings = new PdfModelSettings({ dataDir, models });
  t.after(() => {
    settings.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { settings, listed, dataDir };
}

test("no PDF model is chosen at first, so PDF reading is unavailable", (t) => {
  const { settings } = fixture(t);
  assert.deepEqual(settings.get(), { revision: 0, ready: false, reason: "notSet" });
  assert.deepEqual(settings.resolve(), { ready: false });
  assert.equal(settings.selection(), null);
});

test("a vision model of a usable connection becomes the PDF model", (t) => {
  const { settings } = fixture(t);
  const saved = settings.save({ revision: 0, connectionId: "router", modelId: "vision" });
  assert.deepEqual(saved, {
    revision: 1,
    connectionId: "router",
    modelId: "vision",
    images: true,
    ready: true,
  });
  assert.deepEqual(settings.resolve(), {
    ready: true,
    connectionId: "router",
    modelId: "vision",
  });
  assert.deepEqual(settings.selection(), { connectionId: "router", modelId: "vision" });
  // Clearing makes it unavailable again.
  const cleared = settings.save({ revision: 1, connectionId: null, modelId: null });
  assert.deepEqual(cleared, { revision: 2, ready: false, reason: "notSet" });
});

test("a signed-in ChatGPT account counts also while the Gateway is stopped", (t) => {
  const { settings } = fixture(t);
  const saved = settings.save({
    revision: 0,
    connectionId: "openclaw:abc",
    modelId: "gpt-5.5",
  });
  assert.equal(saved.ready, true);
  assert.throws(
    () =>
      settings.save({ revision: 1, connectionId: "openclaw:off", modelId: "gpt-5.5" }),
    { key: "provider" },
  );
});

test("a text-only model reads PDF text and says that scans stay unreadable", (t) => {
  const { settings } = fixture(t);
  const saved = settings.save({
    revision: 0,
    connectionId: "router",
    modelId: "text-only",
  });
  assert.deepEqual(saved, {
    revision: 1,
    connectionId: "router",
    modelId: "text-only",
    images: false,
    ready: true,
  });
  assert.deepEqual(settings.selection(), {
    connectionId: "router",
    modelId: "text-only",
  });
});

test("unusable connections and invalid input are refused", (t) => {
  const { settings } = fixture(t);
  for (const connectionId of ["keyless", "missing"])
    assert.throws(() => settings.save({ revision: 0, connectionId, modelId: "vision" }), {
      key: "provider",
    });
  for (const input of [
    null,
    [],
    { revision: 0, connectionId: "router" },
    { revision: 0, modelId: "vision" },
    { revision: "0", connectionId: "router", modelId: "vision" },
    { revision: 0, connectionId: "router", modelId: "vision", apiKey: "x" },
    { revision: 0, connectionId: "router", modelId: " " },
    { revision: 0, connectionId: "router", modelId: "x".repeat(257) },
  ])
    assert.throws(() => settings.save(input), { key: "invalid" });
  assert.throws(
    () => settings.save({ revision: 3, connectionId: "router", modelId: "vision" }),
    { key: "conflict", status: 409 },
  );
  assert.equal(settings.get().revision, 0);
});

test("a chosen model that stops working says why and is not compiled", (t) => {
  const { settings, listed } = fixture(t);
  settings.save({ revision: 0, connectionId: "router", modelId: "vision" });
  listed[0].available = false;
  assert.deepEqual(settings.get(), {
    revision: 1,
    connectionId: "router",
    modelId: "vision",
    images: true,
    ready: false,
    reason: "connectionUnavailable",
  });
  assert.equal(settings.selection(), null);
  listed.splice(0, 1);
  assert.equal(settings.get().reason, "connectionMissing");
});

test("preview validates like save and stores nothing", (t) => {
  const { settings } = fixture(t);
  assert.deepEqual(
    settings.preview({ revision: 0, connectionId: "router", modelId: "vision" }),
    { ready: true, connectionId: "router", modelId: "vision" },
  );
  assert.deepEqual(settings.preview({ revision: 0, connectionId: null, modelId: null }), {
    ready: false,
  });
  assert.equal(settings.get().revision, 0);
});
