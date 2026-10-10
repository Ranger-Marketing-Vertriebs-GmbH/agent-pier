import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRuntimeUpdateRoutes } from "../../server/http/routes/assistant-runtime-updates.js";

test("runtime update routes require owner auth, reject runtime inputs, and sanitize errors", async (t) => {
  const app = express();
  const calls = [];
  const assistants = { maintenance: false };
  let recoveryRequired = false;
  app.use(express.json());
  app.use((req, res, next) =>
    req.headers.authorization === "Bearer owner" ? next() : res.sendStatus(401),
  );
  app.use(
    assistantRuntimeUpdateRoutes({
      assistants,
      assistantUpdates: {
        status: () => ({
          phase: "staged",
          currentVersion: "old",
          targetVersion: "new",
          recoveryRequired,
        }),
        stage: async () => {
          calls.push("stage");
          return { phase: "staged" };
        },
        activate: async () => {
          throw Error("private token /host/state");
        },
        recover: async () => {
          calls.push("recover");
          if (recoveryRequired) return {};
          throw Object.assign(Error("private blocker"), { status: 409 });
        },
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/assistant-runtime/updates`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { authorization: "Bearer owner", "content-type": "application/json" };
  const status = await fetch(url, { headers });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal((await status.json()).targetVersion, "new");
  for (const body of ['{"version":"arbitrary"}', "[]", "null"]) {
    assert.equal(
      (await fetch(`${url}/stage`, { method: "POST", headers, body })).status,
      400,
    );
  }
  assert.equal(
    (await fetch(`${url}/stage`, { method: "POST", headers, body: "{}" })).status,
    200,
  );
  assert.deepEqual(calls, ["stage"]);
  const failed = await fetch(`${url}/activate`, { method: "POST", headers, body: "{}" });
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes("private"), false);
  assert.equal(
    (await fetch(`${url}/recover`, { method: "POST", headers, body: "{}" })).status,
    409,
  );
  assistants.maintenance = true;
  for (const action of ["stage", "activate", "recover"])
    assert.equal(
      (await fetch(`${url}/${action}`, { method: "POST", headers, body: "{}" })).status,
      409,
    );
  assert.deepEqual(calls, ["stage", "recover"]);
  recoveryRequired = true;
  assert.equal(
    (await fetch(`${url}/recover`, { method: "POST", headers, body: "{}" })).status,
    200,
  );
});
