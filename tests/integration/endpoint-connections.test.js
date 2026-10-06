import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";

export const ollama = {
  preset: "ollama",
  openaiBaseUrl: "http://127.0.0.1:11434/v1",
  anthropicBaseUrl: "http://127.0.0.1:11434",
  protocols: { messages: true, responses: true, chatCompletions: true },
  authHeader: null,
  models: [
    {
      modelId: "qwen3",
      label: "qwen3",
      contextTokens: 32768,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
    },
  ],
  lastTest: null,
};
function store(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-endpoint-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, connections: new ProviderConnections({ dataDir }) };
}

test("keyless endpoint connection is launchable and exposes its tools", (t) => {
  const { connections } = store(t);
  const created = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  assert.equal(created.hasSecret, false);
  assert.equal(created.launchable, true);
  assert.deepEqual(created.tools, ["codex", "claude", "opencode"]);
  assert.equal(created.endpoint.models[0].modelId, "qwen3");
  assert.equal(created.responsesAccess, undefined);
  assert.equal(connections.record(created.id).endpoint.preset, "ollama");
});

test("catalog connections without key are not launchable", (t) => {
  const { connections } = store(t);
  assert.equal(
    connections.create({ name: "R", providerId: "openrouter" }).launchable,
    false,
  );
  assert.throws(
    () => connections.create({ name: "R", providerId: "openrouter", endpoint: ollama }),
    { status: 400 },
  );
});

test("endpoint connections require an endpoint block and catalog ones reject it on update", (t) => {
  const { connections } = store(t);
  assert.throws(() => connections.create({ name: "E", providerId: "endpoint" }), {
    status: 400,
  });
  const { id } = connections.create({ name: "R", providerId: "openrouter" });
  assert.throws(() => connections.update(id, { endpoint: ollama }), { status: 400 });
});

test("changing the origin requires key re-entry or removal", (t) => {
  const { connections } = store(t);
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
    apiKey: "secret-1",
  });
  const moved = {
    ...ollama,
    openaiBaseUrl: "http://10.0.0.9:11434/v1",
    anthropicBaseUrl: "http://10.0.0.9:11434",
  };
  assert.throws(() => connections.update(id, { endpoint: moved }), { status: 409 });
  assert.equal(connections.secret(id).apiKey, "secret-1");
  // Path-only change keeps the key.
  connections.update(id, {
    endpoint: { ...ollama, openaiBaseUrl: "http://127.0.0.1:11434/api/v1" },
  });
  assert.equal(connections.secret(id).apiKey, "secret-1");
  connections.update(id, { endpoint: moved, apiKey: "secret-2" });
  assert.equal(connections.secret(id).apiKey, "secret-2");
  connections.update(id, { endpoint: ollama, removeApiKey: true });
  assert.equal(connections.secret(id), null);
});

test("invalid stored endpoint records are skipped, not fatal, and preserved on save", (t) => {
  const { dataDir, connections } = store(t);
  const good = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  const file = path.join(dataDir, "provider-connections.json");
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  const badId = "00000000-0000-4000-8000-000000000000";
  const bad = { ...records[0], id: badId, endpoint: { preset: "bad" } };
  records.push(bad);
  fs.writeFileSync(file, JSON.stringify(records));
  const reloaded = new ProviderConnections({ dataDir });
  assert.deepEqual(
    reloaded.list().map((item) => item.id),
    [good.id],
  );
  assert.deepEqual(reloaded.invalid, [badId]);
  reloaded.update(good.id, { name: "Renamed" });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    saved.find((record) => record.id === badId),
    bad,
  );
  assert.equal(saved.length, 2);
});
