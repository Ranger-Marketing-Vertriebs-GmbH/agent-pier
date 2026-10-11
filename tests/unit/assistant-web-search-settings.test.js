import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSearchSettings } from "../../server/features/assistants/web-search-settings.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-search-"));
  const connections = new ProviderConnections({
    dataDir: path.join(dataDir, "providers"),
  });
  const settings = new WebSearchSettings({ dataDir, connections });
  t.after(() => {
    settings.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { settings, connections };
}
test("duckduckgo is the ready default", (t) => {
  const { settings } = fixture(t);
  assert.deepEqual(settings.get(), {
    revision: 0,
    provider: "duckduckgo",
    hasBraveKey: false,
    ready: true,
  });
  assert.deepEqual(settings.resolve(), { provider: "duckduckgo", requiresPlugin: true });
});
test("brave stores its key privately and deletes it on null", (t) => {
  const { settings } = fixture(t);
  const noKey = settings.save({ revision: 0, provider: "brave" });
  assert.equal(noKey.ready, false);
  assert.deepEqual(settings.resolve(), {
    provider: "brave",
    requiresPlugin: true,
    unavailable: true,
  });
  const saved = settings.save({ revision: 1, provider: "brave", braveKey: "BSA-secret" });
  assert.equal(saved.hasBraveKey, true);
  assert.equal(saved.ready, true);
  assert.ok(!JSON.stringify(settings.get()).includes("BSA-secret"));
  assert.equal(settings.resolve().key, "BSA-secret");
  assert.equal(settings.save({ revision: 2, provider: "brave" }).hasBraveKey, true);
  const removed = settings.save({ revision: 3, provider: "brave", braveKey: null });
  assert.equal(removed.hasBraveKey, false);
  assert.equal(removed.ready, false);
});
test("perplexity uses the key of a chosen OpenRouter connection", (t) => {
  const { settings, connections } = fixture(t);
  const router = connections.create({
    name: "OR",
    providerId: "openrouter",
    apiKey: "or-secret",
  });
  const saved = settings.save({
    revision: 0,
    provider: "perplexity",
    connectionId: router.id,
  });
  assert.equal(saved.ready, true);
  assert.equal(saved.connectionId, router.id);
  assert.ok(!JSON.stringify(saved).includes("or-secret"));
  assert.equal(settings.resolve().key, "or-secret");
  connections.remove(router.id);
  assert.equal(settings.get().ready, false);
  assert.equal(settings.resolve().unavailable, true);
});
test("perplexity without a valid OpenRouter connection is not ready", (t) => {
  const { settings, connections } = fixture(t);
  assert.equal(
    settings.save({ revision: 0, provider: "perplexity", connectionId: "missing" }).ready,
    false,
  );
  const other = connections.create({ name: "Z", providerId: "zai", apiKey: "zai-key" });
  assert.equal(
    settings.save({ revision: 1, provider: "perplexity", connectionId: other.id }).ready,
    false,
  );
  assert.equal(settings.save({ revision: 2, provider: "perplexity" }).ready, false);
});
test("stale revisions and invalid input are rejected", (t) => {
  const { settings } = fixture(t);
  settings.save({ revision: 0, provider: "duckduckgo" });
  assert.throws(() => settings.save({ revision: 0, provider: "duckduckgo" }), {
    status: 409,
  });
  assert.throws(() => settings.save({ revision: 1, provider: "bing" }), { status: 400 });
  assert.throws(
    () => settings.save({ revision: 1, provider: "brave", braveKey: "a b" }),
    {
      status: 400,
    },
  );
  assert.throws(() => settings.save({ revision: 1, provider: "brave", extra: 1 }), {
    status: 400,
  });
});
