import test from "node:test";
import assert from "node:assert/strict";
import { createSessionLifecycle } from "../../server/application/session-lifecycle.js";
import { SessionOperations } from "../../server/features/sessions/session-operations.js";
function fixture(count = 0) {
  const sessions = Array.from({ length: count }, (_, i) => ({
    id: `old-${i}`,
    status: "running",
    accountId: "old",
  }));
  const operations = new SessionOperations(() => Promise.resolve());
  const services = {
    config: { home: "/tmp", dataDir: "/tmp" },
    accounts: { command: () => ({ command: "/bin/sh", args: [], env: {} }) },
    providerAccess: {
      resolve: () => ({
        account: { id: "account", tool: "codex", name: "test" },
      }),
    },
    preferences: { get: () => ({ defaultCwd: "/tmp" }) },
    tools: () => [],
    directory: async (x) => x,
    sessions: {
      list: async () => [...sessions],
      create: (options) =>
        operations.run(async () => {
          const session = { ...options, status: "running" };
          sessions.push(session);
          return session;
        }),
    },
  };
  for (const key of ["github", "agentbus", "memoryIntegration", "bindings", "requests"])
    services[key] = {
      prepare: async ({ launch }) => launch,
      discard: async () => {},
    };
  return { sessions, services, ...createSessionLifecycle(services) };
}

test("parallel logins cannot bypass account exclusivity", async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([f.launch({}, true), f.launch({}, true)]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.sessions.length, 1);
});
test("parallel launches reserve global capacity before preparing different accounts", async () => {
  const f = fixture(29);
  let account = 0;
  f.services.providerAccess.resolve = () => ({
    account: { id: `account-${account++}`, tool: "codex", name: "test" },
  });
  const outcomes = await Promise.allSettled([f.launch({}, true), f.launch({}, true)]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.sessions.length, 30);
});
test("failed preparations release their reservation", async () => {
  const f = fixture(29);
  f.services.github.prepare = async () => {
    throw Error("Preparation failed");
  };
  await assert.rejects(f.launch({}, true), /Preparation failed/);
  f.services.github.prepare = async ({ launch }) => launch;
  await f.launch({}, true);
  assert.equal(f.sessions.length, 30);
});
