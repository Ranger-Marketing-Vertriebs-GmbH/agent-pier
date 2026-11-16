import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantAdvancedSettingsRoutes } from "../../server/http/routes/assistant-advanced-settings.js";
import { DatabaseSync } from "node:sqlite";
import { restartRequired } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { AdvancedConfig } from "../../server/features/assistants/advanced-config.js";
import { OverrideStore } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/overrides.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";

async function serve(t, advanced) {
  const app = express();
  app.use(express.json());
  app.use(assistantAdvancedSettingsRoutes({ assistantAdvancedConfig: advanced }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message, key: error.key }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}/assistant-advanced-settings`;
  return async (method, body) => {
    const response = await fetch(base, {
      method,
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: await response.json(),
    };
  };
}

test("reads and saves settings, asks to restart and hides runtime errors", async (t) => {
  const calls = [];
  const advanced = {
    get: async () => ({ runtimes: [{ id: "one", running: true }], settings: [] }),
    async save(id, value, options) {
      calls.push([id, value, options]);
      if (id === "fails") throw Object.assign(Error("/private/openclaw.json"), {});
      if (!options.confirmed)
        throw restartRequired("advancedRestartRequired", { agents: [], teamMembers: 0 });
      return { saved: id };
    },
    // A runtime's own described setting, by runtime id and field id.
    async saveOwn(runtime, field, value, options) {
      calls.push([runtime, field, value, options]);
      return { saved: `${runtime}.${field}` };
    },
  };
  const request = await serve(t, advanced);
  const read = await request("GET");
  assert.equal(read.status, 200);
  assert.equal(read.cache, "no-store");
  assert.deepEqual(read.body.runtimes, [{ id: "one", running: true }]);
  const asked = await request("PUT", { setting: "mediaRetention", value: 24 });
  assert.equal(asked.status, 409);
  assert.equal(asked.body.code, "ASSISTANT_RESTART_REQUIRED");
  assert.deepEqual(asked.body.affected, { agents: [], teamMembers: 0 });
  const saved = await request("PUT", {
    setting: "mediaRetention",
    value: null,
    confirmRestart: true,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(calls.at(-1), ["mediaRetention", null, { confirmed: true }]);
  const own = await request("PUT", { runtime: "one", field: "workers", value: 4 });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, { saved: "one.workers" });
  assert.deepEqual(calls.at(-1), ["one", "workers", 4, { confirmed: false }]);
  const sent = calls.length;
  for (const body of [
    { setting: "x" },
    { setting: 1, value: 1 },
    { setting: "x", value: 1, extra: true },
    [1],
    // The body of an AgentPier before runtimes took settings by id.
    { path: "attachments.ttlHours", value: 72 },
    // One setting per request: a shared one or a runtime's own, never both.
    { setting: "x", runtime: "one", field: "workers", value: 1 },
    { runtime: "one", value: 1 },
    { field: "workers", value: 1 },
    { runtime: "one", field: 2, value: 1 },
    { runtime: "one", field: "workers" },
  ]) {
    const refused = await request("PUT", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, sent);
  const failed = await request("PUT", {
    setting: "fails",
    value: 1,
    confirmRestart: true,
  });
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(failed.body).includes("/private"), false);
});

test("the real service refuses paths and values off the allow list", async (t) => {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const overrides = new OverrideStore(db);
  const advanced = new AdvancedConfig({
    assistants: {
      runtime: { status: () => ({ availability: "disabled", version: null }) },
      admit: (operation) => operation(),
    },
    overrides,
    synchronization: {},
  });
  const request = await serve(t, advanced);
  for (const body of [
    { setting: "gateway.auth.token", value: "x" },
    { setting: "attachments.ttlHours", value: 72 },
    { setting: "__proto__", value: 1 },
    { setting: "__proto__.polluted", value: 1 },
    // An own "__proto__" key, as JSON.parse creates it from a request body.
    { setting: "mediaRetention", value: JSON.parse('{"__proto__":{"polluted":1}}') },
    { setting: "mediaRetention", value: 24 },
    { setting: "imageMaxDimension", value: 4000 },
    // No shipped runtime describes a setting of its own.
    { runtime: "openclaw", field: "workers", value: 4 },
    { runtime: "__proto__", field: "constructor", value: 4 },
  ]) {
    const refused = await request("PUT", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(overrides.list(), []);
  assert.equal(Object.prototype.polluted, undefined);
  const saved = await request("PUT", { setting: "mediaRetention", value: 72 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.find((s) => s.id === "mediaRetention").override, 72);
  assert.deepEqual(
    overrides.list().map((row) => row.path),
    ["attachments.ttlHours"],
  );
});
