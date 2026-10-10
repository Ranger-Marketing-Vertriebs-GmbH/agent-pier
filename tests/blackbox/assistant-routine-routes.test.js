import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRoutineRoutes } from "../../server/http/routes/assistant-routines.js";
test("owner routine routes pass only scoped identities and never expose upstream errors", async (t) => {
  const calls = [],
    app = express();
  app.use(express.json());
  app.use((req, res, next) =>
    req.headers.authorization === "Bearer owner" ? next() : res.sendStatus(401),
  );
  app.use(
    assistantRoutineRoutes({
      assistantRoutines: {
        list: async (id) => ({ routines: [{ id }] }),
        trigger: async (...args) => {
          calls.push(args);
          return { eventId: args[2].eventId, status: "queued" };
        },
        create: async () => {
          throw Error("secret upstream token");
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
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}/assistants/a/routines`;
  assert.equal((await fetch(`${url}/r/events`, { method: "POST" })).status, 401);
  const headers = { authorization: "Bearer owner", "content-type": "application/json" };
  const event = await fetch(`${url}/r/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ eventId: "saved-event" }),
  });
  assert.equal(event.status, 202);
  assert.deepEqual(calls, [["a", "r", { eventId: "saved-event" }]]);
  assert.equal(event.headers.get("cache-control"), "no-store");
  const failed = await fetch(url, { method: "POST", headers, body: "{}" });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("secret"));
});
