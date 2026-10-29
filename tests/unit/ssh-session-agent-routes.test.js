import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { sshRoutes } from "../../server/http/routes/ssh.js";
import { registerResponses } from "../../server/http/responses.js";
import { ProjectRebind } from "../../server/application/project-rebind.js";
import { createShutdown } from "../../server/application/shutdown.js";

const ready = { state: "ready", aliases: { "access-a": "proxmox-2" } };

async function withRoutes(t, { sync }) {
  const order = [];
  const session = { id: "s1", status: "running" };
  const services = {
    sessions: { get: async () => session },
    sshAccesses: {},
    sshSessions: {
      get: async () => ({ accessIds: [] }),
      set: async (_session, ids) => {
        order.push("set");
        return { accessIds: ids };
      },
    },
    sshAgents: {
      sync: async (given) => {
        order.push("sync");
        assert.equal(given, session);
        return sync();
      },
      status: (given) => {
        order.push("status");
        assert.equal(given, session);
        return ready;
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api", sshRoutes(services));
  registerResponses(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/sessions/s1/ssh-accesses`;
  return { order, url };
}

test("the session SSH response names the agent's state and aliases", async (t) => {
  const f = await withRoutes(t, { sync: async () => "unchanged" });
  const body = await (await fetch(f.url)).json();
  assert.deepEqual(body, { accessIds: [], agent: ready });
});

test("a changed assignment is saved, then synced into the agent, then answered", async (t) => {
  const f = await withRoutes(t, { sync: async () => "written" });
  const response = await fetch(f.url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessIds: ["access-a"] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accessIds: ["access-a"], agent: ready });
  assert.deepEqual(f.order, ["set", "sync", "status"]);
});

test("a failed agent sync keeps the saved assignment and is not logged again", async (t) => {
  const f = await withRoutes(t, {
    sync: async () => {
      throw Object.assign(new Error("disk"), { code: "EACCES" });
    },
  });
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  t.after(() => (console.error = original));
  const response = await fetch(f.url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessIds: ["access-a"] }),
  });
  console.error = original;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).accessIds, ["access-a"]);
  assert.deepEqual(f.order, ["set", "sync", "status"]);
  // SessionSshAgents logs the failed write itself (ssh-session-agents-failures.test.js).
  assert.deepEqual(logged, []);
});

test("a session whose SSH binding moves to the new project refreshes the agents", async () => {
  const record = {
    id: "s",
    sshTools: { enabled: true, project: { projectId: "FROM", launch: "/p" } },
  };
  let refreshes = 0;
  const rebind = new ProjectRebind({
    dataDir: "/nonexistent",
    memory: {},
    sshManagement: {},
    sshAgents: {
      refresh: async () => {
        refreshes += 1;
      },
    },
    artifacts: {},
    sessions: { metadata: async () => structuredClone(record), save: async () => {} },
    audit: {},
  });
  const scope = { id: "TO", name: "p", cwd: "/p", kind: "git", identity: "i" };
  await rebind.rebindSession("s", "OTHER", scope, null);
  assert.equal(refreshes, 0);
  await rebind.rebindSession("s", "FROM", scope, null);
  assert.equal(refreshes, 1);
});

test("shutdown closes the session agents' listeners", async () => {
  const closed = [];
  const named = (name) => ({ close: async () => closed.push(name) });
  const services = {
    agentbus: named("agentbus"),
    installer: named("installer"),
    plugins: named("plugins"),
    repositories: named("repositories"),
    extensions: named("extensions"),
    history: named("history"),
    sessions: named("sessions"),
    memoryIntegration: named("memoryIntegration"),
    memory: { close: () => {} },
    audit: { close: () => closed.push("audit") },
    sshManagement: named("sshManagement"),
    sshAgents: named("sshAgents"),
  };
  const server = { listening: false };
  await createShutdown({ services, wss: null, server })();
  assert.ok(closed.includes("sshAgents"));
  // The last audit rows of the agents are flushed before the audit store closes.
  assert.ok(closed.indexOf("sshAgents") < closed.indexOf("audit"));
});
