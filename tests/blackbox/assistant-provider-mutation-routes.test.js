import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { providerConnectionRoutes } from "../../server/http/routes/provider-connections.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";

test("central provider mutation routes await the assistant synchronization boundary", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-provider-routes-"));
  const connections = new ProviderConnections({ dataDir });
  const c = connections.create({
    providerId: "openrouter",
    name: "Router",
    apiKey: "fixture-secret",
  });
  const calls = [];
  let blocked = true;
  const app = express();
  app.use(express.json());
  app.use(
    providerConnectionRoutes({
      providerConnections: connections,
      assistantProviderSynchronization: {
        async change(id, operation) {
          calls.push(id);
          await Promise.resolve();
          if (blocked) throw Object.assign(Error("active"), { status: 409 });
          return operation();
        },
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/provider-connections/${c.id}`;
  const patch = () =>
    fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "fixture-rotated" }),
    });
  assert.equal((await patch()).status, 409);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 409);
  assert.equal(connections.secret(c.id).apiKey, "fixture-secret");
  blocked = false;
  const changed = await patch();
  assert.equal(changed.status, 200);
  assert.equal(JSON.stringify(await changed.json()).includes("fixture-rotated"), false);
  assert.equal(connections.secret(c.id).apiKey, "fixture-rotated");
  assert.equal((await fetch(url, { method: "DELETE" })).status, 204);
  assert.equal(connections.list().length, 0);
  assert.deepEqual(calls, [c.id, c.id, c.id, c.id]);
});

test("changing a connection agents use requires confirming the Gateway restart", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-provider-confirm-"));
  const connections = new ProviderConnections({ dataDir });
  const used = connections.create({
    providerId: "openrouter",
    name: "Agents",
    apiKey: "fixture-secret",
  });
  const unused = connections.create({
    providerId: "openrouter",
    name: "Sessions",
    apiKey: "fixture-other",
  });
  const restarts = [];
  const app = express();
  app.use(express.json());
  app.use(
    providerConnectionRoutes({
      providerConnections: connections,
      assistantProviderSynchronization: {
        async change(id, operation, { confirmed }) {
          // Mirrors AssistantProviderSynchronization: usage and consent are checked together.
          if (id === used.id && !confirmed)
            throw Object.assign(Error("restart"), {
              status: 409,
              code: "ASSISTANT_RESTART_REQUIRED",
              affected: { agents: [{ id: "a", name: "Olli" }], teamMembers: 2 },
            });
          const result = await operation();
          if (id === used.id) restarts.push(id);
          return result;
        },
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/provider-connections`;
  const send = (id, method, body) =>
    fetch(`${base}/${id}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const refused = await send(used.id, "PATCH", { apiKey: "fixture-rotated" });
  assert.equal(refused.status, 409);
  const problem = await refused.json();
  assert.equal(problem.code, "ASSISTANT_RESTART_REQUIRED");
  assert.equal(typeof problem.error, "string");
  assert.deepEqual(problem.affected, {
    agents: [{ id: "a", name: "Olli" }],
    teamMembers: 2,
  });
  assert.equal(connections.secret(used.id).apiKey, "fixture-secret");
  assert.equal((await send(used.id, "DELETE", {})).status, 409);
  assert.deepEqual(restarts, []);

  const confirmed = await send(used.id, "PATCH", {
    apiKey: "fixture-rotated",
    confirmRestart: true,
  });
  assert.equal(confirmed.status, 200);
  assert.equal(connections.secret(used.id).apiKey, "fixture-rotated");
  assert.deepEqual(restarts, [used.id]);
  // Connections no agent uses change without a confirmation.
  assert.equal((await send(unused.id, "PATCH", { name: "Renamed" })).status, 200);
  assert.equal((await send(unused.id, "DELETE", {})).status, 204);
  assert.equal((await send(used.id, "DELETE", { confirmRestart: false })).status, 409);
  assert.equal((await send(used.id, "DELETE", { confirmRestart: true })).status, 204);
  assert.deepEqual(restarts, [used.id, used.id]);
  assert.equal(connections.list().length, 0);
});
