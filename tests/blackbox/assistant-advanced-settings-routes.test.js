import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantAdvancedSettingsRoutes } from "../../server/http/routes/assistant-advanced-settings.js";
import { restartRequired } from "../../server/features/assistants/assistant-provider-synchronization.js";

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
    get: async () => ({ gateway: { running: true }, settings: [] }),
    async save(path, value, options) {
      calls.push([path, value, options]);
      if (path === "fails") throw Object.assign(Error("/private/openclaw.json"), {});
      if (!options.confirmed)
        throw restartRequired("advancedRestartRequired", { agents: [], teamMembers: 0 });
      return { saved: path };
    },
  };
  const request = await serve(t, advanced);
  const read = await request("GET");
  assert.equal(read.status, 200);
  assert.equal(read.cache, "no-store");
  assert.deepEqual(read.body.gateway, { running: true });
  const asked = await request("PUT", { path: "attachments.ttlHours", value: 24 });
  assert.equal(asked.status, 409);
  assert.equal(asked.body.code, "ASSISTANT_RESTART_REQUIRED");
  assert.deepEqual(asked.body.affected, { agents: [], teamMembers: 0 });
  const saved = await request("PUT", {
    path: "attachments.ttlHours",
    value: null,
    confirmRestart: true,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(calls.at(-1), ["attachments.ttlHours", null, { confirmed: true }]);
  for (const body of [
    { path: "x" },
    { path: 1, value: 1 },
    { path: "x", value: 1, extra: true },
    [1],
  ]) {
    const refused = await request("PUT", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  const failed = await request("PUT", { path: "fails", value: 1, confirmRestart: true });
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(failed.body).includes("/private"), false);
});
