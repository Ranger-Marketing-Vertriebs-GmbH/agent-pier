import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionLifecycle } from "../../server/application/session-lifecycle.js";
import { buildSessionLaunch } from "../../server/features/sessions/session-creation.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const startedBy = { kind: "agent", assistantId: "a1", name: "Home" };

function fixture() {
  const created = [];
  const services = {
    config: { home: "/tmp", dataDir: "/tmp" },
    accounts: {
      verifyEndpointTarget: async () => {},
      command: () => ({ command: "/bin/sh", args: [], env: {} }),
    },
    providerAccess: {
      resolve: () => ({ account: { id: "account", tool: "codex", name: "test" } }),
    },
    preferences: { get: () => ({ defaultCwd: "/tmp" }) },
    tools: () => [],
    directory: async (x) => x,
    sessions: {
      list: async () => [],
      create: async (options) => {
        created.push(options);
        return { ...options, status: "running" };
      },
    },
  };
  for (const key of [
    "github",
    "agentbus",
    "memoryIntegration",
    "bindings",
    "requests",
    "nonoSandbox",
  ])
    services[key] = {
      prepare: async ({ launch }) => launch,
      discard: async () => {},
    };
  return { created, ...createSessionLifecycle(services) };
}

test("the trusted startedBy reaches the created session", async () => {
  const f = fixture();
  await f.launch({}, false, { id: "s1", startedBy });
  assert.deepEqual(f.created[0].startedBy, startedBy);
});

test("a startedBy in the request body is ignored", async () => {
  const f = fixture();
  await f.launch({ startedBy }, false, { id: "s2" });
  assert.equal("startedBy" in f.created[0], false);
});

test("startedBy is refused together with a pipeline", async () => {
  const f = fixture();
  await assert.rejects(
    f.launch({}, false, { id: "s3", startedBy, pipeline: { runId: "r" } }),
  );
  assert.equal(f.created.length, 0);
});

test("startedBy is refused for a login session", async () => {
  const f = fixture();
  await assert.rejects(f.launch({}, true, { id: "s4", startedBy }));
  assert.equal(f.created.length, 0);
});

test("buildSessionLaunch persists a valid startedBy and refuses malformed ones", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-started-by-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = {
    directory,
    file: (id) => path.join(directory, `${id}.json`),
    target: (id) => `tuiui-${id}`,
    newSessionName: (id) => `tuiui-${id}`,
    save: async (session) =>
      fs.writeFileSync(
        path.join(directory, `${session.id}.json`),
        JSON.stringify(session),
      ),
  };
  const options = (extra) => ({
    name: "Agent session",
    tool: "claude",
    accountId: "local-claude",
    cwd: directory,
    command: process.execPath,
    args: [],
    env: {},
    ...extra,
  });
  const { session } = await buildSessionLaunch(manager, options({ startedBy }));
  assert.deepEqual(session.startedBy, startedBy);
  const { session: plain } = await buildSessionLaunch(manager, options());
  assert.equal("startedBy" in plain, false);
  for (const bad of [
    { kind: "agent", assistantId: "../x", name: "Home" },
    { kind: "user", assistantId: "a1", name: "Home" },
    { kind: "agent", assistantId: "a1", name: "x".repeat(101) },
    { kind: "agent", assistantId: "a1", name: 5 },
    "agent",
  ])
    await assert.rejects(
      buildSessionLaunch(manager, options({ startedBy: bad })),
      (error) => {
        assert.equal(error.message, serverMessages.sessions.invalidOptions);
        return true;
      },
    );
});
