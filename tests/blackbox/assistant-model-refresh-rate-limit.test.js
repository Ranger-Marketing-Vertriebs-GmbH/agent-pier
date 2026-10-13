import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRoutes } from "../../server/http/routes/assistants.js";

test("the model refresh rate limiter is built before the first request", async (t) => {
  const reported = [];
  t.mock.method(console, "error", (...args) => reported.push(args));
  t.mock.method(console, "warn", (...args) => reported.push(args));
  const refreshed = [];
  const assistants = { maintenance: false, list: () => ({ assistants: [] }) };
  const assistantModelAccounts = {
    refreshModels: async (id) => {
      refreshed.push(id);
      return { models: [], modelCatalog: "ready" };
    },
  };
  const app = express();
  app.use(
    assistantRoutes({
      assistantFeature: { enabled: true },
      assistants,
      assistantModelAccounts,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/assistant-model-accounts/openclaw%3Afixture/models/refresh`;
  const remaining = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(endpoint, { method: "POST" });
    assert.equal(response.status, 200);
    remaining.push(/; r=(\d+);/.exec(response.headers.get("ratelimit"))?.[1]);
  }
  // Both requests draw from the one owner budget built with the app.
  assert.deepEqual(remaining, ["11", "10"]);
  assert.deepEqual(refreshed, ["openclaw:fixture", "openclaw:fixture"]);
  // Other assistant limiters have their own test; this one covers the refresh.
  const created = reported.filter((args) =>
    args.some(
      (value) =>
        value?.code === "ERR_ERL_CREATED_IN_REQUEST_HANDLER" &&
        value.stack?.includes("assistant-accounts.js"),
    ),
  );
  assert.deepEqual(created, []);
});
