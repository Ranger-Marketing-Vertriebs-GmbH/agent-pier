import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionLifecycle } from "../../server/application/session-lifecycle.js";
import { buildSessionLaunch } from "../../server/features/sessions/session-creation.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const ticket = {
  source: "github",
  key: "o/r#7",
  title: "Fix it",
  url: "https://github.com/o/r/issues/7",
};

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

test("a trusted ticket lands on the session record", async () => {
  const f = fixture();
  await f.launch({ cwd: "/tmp" }, false, { id: "t1", ticket });
  assert.deepEqual(f.created[0].ticket, ticket);
});

test("a ticket in the request body is ignored", async () => {
  const f = fixture();
  await f.launch({ cwd: "/tmp", ticket }, false, { id: "t2" });
  assert.equal("ticket" in f.created[0], false);
});

test("a ticket never comes with a login or pipeline session", async () => {
  const f = fixture();
  const invalid = { message: serverMessages.sessions.invalidOptions };
  await assert.rejects(f.launch({}, true, { id: "t3", ticket }), invalid);
  await assert.rejects(
    f.launch({}, false, { id: "t4", ticket, pipeline: { runId: "r" } }),
    invalid,
  );
  assert.equal(f.created.length, 0);
});

test("buildSessionLaunch keeps a valid ticket and refuses malformed ones", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ticket-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = {
    directory,
    file: (id) => path.join(directory, `${id}.json`),
    target: (id) => `agentpier-${id}`,
    sessionName: (id) => `agentpier-${id}`,
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
  const { session } = await buildSessionLaunch(manager, options({ ticket }));
  assert.deepEqual(session.ticket, ticket);
  const { session: plain } = await buildSessionLaunch(manager, options());
  assert.equal("ticket" in plain, false);
  for (const bad of [
    { ...ticket, source: "jira" },
    { ...ticket, url: "javascript:alert(1)" },
    { ...ticket, title: "x".repeat(201) },
    { ...ticket, key: 5 },
    null,
    "o/r#7",
  ])
    await assert.rejects(
      buildSessionLaunch(manager, options({ ticket: bad })),
      (error) => {
        assert.equal(error.message, serverMessages.sessions.invalidOptions);
        return true;
      },
    );
});
