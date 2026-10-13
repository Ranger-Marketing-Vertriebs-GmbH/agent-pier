import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRoutes } from "../../server/http/routes/assistants.js";

test("assistant routes build their rate limiters before the first request", async (t) => {
  const reported = [];
  t.mock.method(console, "error", (...args) => reported.push(args));
  t.mock.method(console, "warn", (...args) => reported.push(args));
  const assistants = { maintenance: false, list: () => ({ assistants: [] }) };
  const app = express();
  app.use(assistantRoutes({ assistantFeature: { enabled: true }, assistants }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/assistants`);
  assert.equal(response.status, 200);
  const created = reported.filter((args) =>
    args.some((value) => value?.code === "ERR_ERL_CREATED_IN_REQUEST_HANDLER"),
  );
  assert.deepEqual(created, []);
});
