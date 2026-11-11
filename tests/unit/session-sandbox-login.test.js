import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionLifecycle } from "../../server/application/session-lifecycle.js";
import { localHidden } from "../../server/features/clis/claude/login-store.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { sessions as english } from "../../server/lib/i18n/en/sessions.js";

/** A launch whose account store reports `hidden` after the launch settled the login. */
function fixture(hidden, account = { id: "account", tool: "claude", name: "Claude" }) {
  const calls = [];
  const services = {
    config: { home: "/tmp", dataDir: "/tmp" },
    accounts: {
      verifyEndpointTarget: async () => {},
      command: () => {
        calls.push("command");
        return { command: "/bin/sh", args: [], env: {} };
      },
      hiddenLogins: () => {
        calls.push("hidden");
        return hidden;
      },
    },
    providerAccess: { resolve: () => ({ account }) },
    preferences: { get: () => ({ defaultCwd: "/tmp" }) },
    tools: () => [],
    directory: async (x) => x,
    chat: { initialize: () => {} },
    sessions: {
      list: async () => [],
      create: async (options) => {
        calls.push("create");
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
      prepare: async ({ launch }) => {
        calls.push(key);
        return launch;
      },
      discard: async () => {},
    };
  return { calls, ...createSessionLifecycle(services) };
}

test("a sandboxed launch is refused while the account's login is still in the keychain", async () => {
  const f = fixture({ account: "pending" });
  await assert.rejects(f.launch({ nonoProfile: "dev" }, false, { id: "s1" }), {
    message: serverMessages.sessions.sandboxLoginPending,
    status: 409,
  });
  // Asked after the launch gave the login its chance to move, and before anything
  // of the session exists.
  assert.deepEqual(f.calls, ["command", "hidden"]);
});

test("a sandboxed launch of the CLI's own profile is refused when its login is in the keychain", async () => {
  const f = fixture({ account: "local" });
  await assert.rejects(f.launch({ nonoProfile: "dev" }, false, { id: "s1" }), {
    message: serverMessages.sessions.sandboxLoginLocal,
    status: 409,
  });
  assert.equal(f.calls.includes("create"), false);
});

test("unsandboxed launches and readable logins start as before", async () => {
  const plain = fixture({ account: "pending" });
  await plain.launch({}, false, { id: "s1" });
  assert.equal(plain.calls.includes("create"), true);
  assert.equal(plain.calls.includes("hidden"), false);
  const readable = fixture({ other: "pending" });
  await readable.launch({ nonoProfile: "dev" }, false, { id: "s2" });
  assert.equal(readable.calls.includes("create"), true);
  // An account store without managed logins (other platforms) has nothing to ask.
  const f = fixture({});
  await f.launch({ nonoProfile: "dev" }, false, { id: "s3" });
  assert.equal(f.calls.includes("create"), true);
});

test("the refusal says what to do, in both languages", () => {
  for (const catalog of [serverMessages.sessions, english]) {
    assert.match(catalog.sandboxLoginPending, /Sessions?|sessions/);
    assert.notEqual(catalog.sandboxLoginPending, catalog.sandboxLoginLocal);
  }
  assert.match(english.sandboxLoginPending, /Stop the account's sessions/);
  assert.match(english.sandboxLoginLocal, /separate profile/);
});

test("a local profile that signs in through its settings is not counted as hidden", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-local-login-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, ".claude");
  fs.mkdirSync(config);
  assert.equal(localHidden(home), true);
  const settings = (value) =>
    fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify(value));
  for (const value of [
    { apiKeyHelper: "/usr/local/bin/key" },
    { env: { ANTHROPIC_API_KEY: "x" } },
    { env: { ANTHROPIC_AUTH_TOKEN: "x" } },
    { env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
    { env: { CLAUDE_CODE_USE_VERTEX: "1" } },
  ]) {
    settings(value);
    assert.equal(localHidden(home), false, JSON.stringify(Object.keys(value)));
  }
  settings({ theme: "dark", env: { OTHER: "1" } });
  assert.equal(localHidden(home), true);
  fs.writeFileSync(path.join(config, "settings.json"), "{ not json");
  assert.equal(localHidden(home), true);
});
