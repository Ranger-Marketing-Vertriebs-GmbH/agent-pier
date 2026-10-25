import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantHookRoutes } from "../../server/http/routes/assistant-hooks.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";

async function serve(t, hooks) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) =>
    req.headers.authorization === "Bearer owner" ? next() : res.sendStatus(401),
  );
  app.use(assistantHookRoutes({ assistantRoutines: { hooks } }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}/assistants/a/hooks`;
  const headers = { authorization: "Bearer owner", "content-type": "application/json" };
  const send = (path, method = "GET", body) =>
    fetch(`${url}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { url, send };
}

test("owner hook routes map every endpoint to the service and keep responses uncached", async (t) => {
  const calls = [];
  const record =
    (name, result) =>
    (...args) => {
      calls.push([name, ...args]);
      return result;
    };
  const { url, send } = await serve(t, {
    list: record("list", {
      hooks: [{ id: "h" }],
      ceiling: { shell: "off" },
      shellChoices: [],
    }),
    create: record("create", { hook: { id: "h" }, secret: "aph_once" }),
    update: record("update", { id: "h", revision: 2 }),
    remove: record("remove", { removed: true }),
    secret: record("secret", { hook: { id: "h" }, secret: "aph_new" }),
    test: record("test", { eventId: "test-1", status: "accepted" }),
    eventDetail: record("eventDetail", { id: "e" }),
  });
  assert.equal((await fetch(url)).status, 401);
  const list = await send("");
  assert.deepEqual(await list.json(), {
    hooks: [{ id: "h" }],
    ceiling: { shell: "off" },
    shellChoices: [],
  });
  const created = await send("", "POST", { name: "n" });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).secret, "aph_once");
  assert.equal((await send("/h", "PATCH", { revision: 1 })).status, 200);
  assert.deepEqual(await (await send("/h", "DELETE")).json(), { removed: true });
  assert.equal(
    (await (await send("/h/secret", "POST", { revision: 3 })).json()).secret,
    "aph_new",
  );
  const test = await send("/h/test", "POST", {});
  assert.equal(test.status, 202);
  assert.equal((await test.json()).eventId, "test-1");
  assert.deepEqual(await (await send("/h/events/e")).json(), { id: "e" });
  assert.deepEqual(
    calls.map((c) => c.slice(0, 3)),
    [
      ["list", "a"],
      ["create", "a", { name: "n" }],
      ["update", "a", "h"],
      ["remove", "a", "h"],
      ["secret", "a", "h"],
      ["test", "a", "h"],
      ["eventDetail", "a", "h"],
    ].map((c) => c.slice(0, 3)),
  );
  assert.deepEqual(calls[4][3], { revision: 3 });
  assert.equal(calls[6][3], "e");
  for (const response of [list, created, test])
    assert.equal(response.headers.get("cache-control"), "no-store");
});

test("owner hook routes answer unavailable for upstream errors without their text", async (t) => {
  const { send } = await serve(t, {
    create: () => {
      throw Error("secret upstream token");
    },
    update: () => {
      throw assistantProblem("conflict", 409);
    },
    remove: () => {
      throw assistantProblem("notFound", 404);
    },
  });
  const failed = await send("", "POST", {});
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.ok(!(await failed.text()).includes("secret"));
  assert.equal((await send("/h", "PATCH", {})).status, 409);
  assert.equal((await send("/h", "DELETE")).status, 404);
});

test("owner hook routes keep the reason of a hook refusal", async (t) => {
  const { send } = await serve(t, {
    create: () => {
      throw assistantProblem("hookUnavailable", 403);
    },
    update: () => {
      throw assistantProblem("hookRightExceeds", 400);
    },
    test: () => {
      throw assistantProblem("hookUnavailable", 409);
    },
  });
  const message = async (response) => [response.status, (await response.json()).error];
  assert.deepEqual(await message(await send("", "POST", {})), [
    403,
    assistantProblem("hookUnavailable").message,
  ]);
  assert.deepEqual(await message(await send("/h", "PATCH", {})), [
    400,
    assistantProblem("hookRightExceeds").message,
  ]);
  assert.deepEqual(await message(await send("/h/test", "POST", {})), [
    409,
    assistantProblem("hookUnavailable").message,
  ]);
});

test("owner hook routes answer 503 without the hook service", async (t) => {
  const { send } = await serve(t, undefined);
  assert.equal((await send("")).status, 503);
  assert.equal((await send("/h/test", "POST", {})).status, 503);
  assert.equal((await send("/h/events/e")).status, 503);
});

test("listing hooks returns the service view without any secret hash", async (t) => {
  const { send } = await serve(t, {
    list: () => ({
      hooks: [{ id: "h", secretSet: true }],
      ceiling: {},
      shellChoices: [],
    }),
  });
  assert.ok(!(await (await send("")).text()).includes("secretHash"));
});
