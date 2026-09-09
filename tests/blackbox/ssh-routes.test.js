import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { SshSessions } from "../../server/features/ssh/ssh-sessions.js";
import { sshRoutes } from "../../server/http/routes/ssh.js";

test("HTTP assigns existing sessions, validates inputs, revokes deletion and never types into CLI", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-http-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let rows = [{ id: "lab", name: "Lab", host: "192.0.2.1" }];
  const sshAccesses = {
    list: () => rows,
    get: (id) => {
      const row = rows.find((row) => row.id === id);
      if (!row) throw Object.assign(Error("missing"), { status: 404 });
      return row;
    },
    remove: (id) => {
      rows = rows.filter((row) => row.id !== id);
    },
  };
  const sshSessions = new SshSessions({ dataDir, store: sshAccesses });
  const session = {
    id: "existing",
    accountId: "local-codex",
    tool: "codex",
    createdAt: "now",
    status: "running",
  };
  const sessions = {
    get: async () => session,
    input: () => assert.fail("must not type"),
  };
  const app = express();
  let toolsState = "reload-required";
  const sshIntegration = {
    status: (current) => {
      assert.equal(current, session);
      return { state: toolsState, ready: toolsState === "ready" };
    },
  };
  app.use(
    express.json(),
    sshRoutes({ sshAccesses, sshSessions, sessions, sshIntegration }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (route, method = "GET", body) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.deepEqual(
    (await (await request("/sessions/existing/ssh-accesses")).json()).assignedIds,
    [],
  );
  assert.equal(
    (await (await request("/sessions/existing/ssh-accesses")).json()).tools.state,
    "reload-required",
  );
  toolsState = "ready";
  let response = await request("/sessions/existing/ssh-accesses", "PUT", {
    accessIds: ["lab"],
  });
  assert.equal(response.status, 200);
  const assigned = await response.json();
  assert.deepEqual(assigned.assignedIds, ["lab"]);
  assert.deepEqual(assigned.tools, { state: "ready", ready: true });
  assert.equal((await request("/sessions/existing/ssh-accesses", "PUT", {})).status, 400);
  assert.equal(
    (await request("/sessions/existing/ssh-accesses", "PUT", { accessIds: ["missing"] }))
      .status,
    404,
  );
  assert.deepEqual(sshSessions.get(session).assignedIds, ["lab"]);
  assert.equal((await request("/ssh-accesses/lab", "DELETE")).status, 204);
  assert.deepEqual(sshSessions.get(session).assignedIds, []);
  session.status = "stopped";
  assert.equal(
    (await request("/sessions/existing/ssh-accesses", "PUT", { accessIds: [] })).status,
    409,
  );
});
