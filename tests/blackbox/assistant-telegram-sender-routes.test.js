import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantTelegramSenderRoutes } from "../../server/http/routes/assistant-telegram-senders.js";
import { restartRequired } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";

async function serve(t, senders) {
  const app = express();
  app.use(express.json());
  app.use(assistantTelegramSenderRoutes({ assistantTelegramSenders: senders }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message, key: error.key }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      text: await response.text(),
    };
  };
}

test("saves ask to restart, pass the confirmation and never echo the token", async (t) => {
  const calls = [];
  const senders = {
    get: async (id) => ({ assistantId: id, bot: null }),
    async save(id, input, options) {
      calls.push(["save", id, input, options]);
      if (!options.confirmed)
        throw restartRequired("telegramSendersRestartRequired", {
          agents: [{ id, name: "Home" }],
          teamMembers: 0,
        });
      return { assistantId: id, bot: { username: "agent_bot", people: input.people } };
    },
    async remove(id, revision, options) {
      calls.push(["remove", id, revision, options]);
      throw Object.assign(Error("private /path/openclaw.json botToken=123:abc"), {
        status: 500,
      });
    },
    async apply(options) {
      calls.push(["apply", options]);
      return { applied: false };
    },
  };
  const request = await serve(t, senders);
  const input = { token: "123:secret-token", people: [{ id: "1", name: "A" }] };
  const asked = await request("PUT", "/assistant-telegram-senders/a1", {
    ...input,
    revision: null,
  });
  assert.equal(asked.status, 409);
  assert.equal(asked.cache, "no-store");
  const body = JSON.parse(asked.text);
  assert.equal(body.code, "ASSISTANT_RESTART_REQUIRED");
  assert.deepEqual(body.affected.agents, [{ id: "a1", name: "Home" }]);
  assert.ok(!asked.text.includes("secret-token"));
  const saved = await request("PUT", "/assistant-telegram-senders/a1", {
    ...input,
    revision: null,
    confirmRestart: true,
  });
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes("secret-token"));
  // The confirmation is an option, not part of the stored input.
  assert.deepEqual(calls[1], [
    "save",
    "a1",
    { ...input, revision: null },
    { confirmed: true },
  ]);
  // Unexpected errors never carry their private text.
  const failed = await request("DELETE", "/assistant-telegram-senders/a1", {
    revision: 2,
  });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(failed.text, /openclaw\.json|botToken/);
  assert.deepEqual(calls[2], ["remove", "a1", 2, { confirmed: false }]);
  const applied = await request("POST", "/assistant-telegram-senders/apply", {
    confirmRestart: true,
  });
  assert.deepEqual(JSON.parse(applied.text), { applied: false });
  assert.deepEqual(calls[3], ["apply", { confirmed: true }]);
});

test("validation errors keep their reason", async (t) => {
  const request = await serve(t, {
    save: async () => {
      throw assistantProblem("telegramBotInUse", 409);
    },
  });
  const response = await request("PUT", "/assistant-telegram-senders/a1", {
    revision: null,
  });
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(response.text).key, "telegramBotInUse");
});

test("the application mounts the routes for the owner only", async (t) => {
  const { url } = await applicationFixture(t, enabledAssistants);
  const path = "/api/assistant-telegram-senders/unknown";
  assert.equal((await fetch(url + path)).status, 401);
  assert.equal((await fixtureFetch(url + path)).status, 404);
  const malformed = await fixtureFetch(url + path, {
    method: "PUT",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ token: "not-a-token", revision: null }),
  });
  assert.ok([400, 404].includes(malformed.status));
});
