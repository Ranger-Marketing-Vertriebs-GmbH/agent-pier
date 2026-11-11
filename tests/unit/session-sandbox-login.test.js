import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionLifecycle } from "../../server/application/session-lifecycle.js";
import {
  localHidden,
  managedHidden,
} from "../../server/features/clis/claude/login-store.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { sessions as english } from "../../server/lib/i18n/en/sessions.js";

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-sandbox-login-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A launch of an account whose login is still in the keychain (`root` is an account
 * folder without the file-store marker), decided by the real check. `env` is what
 * the launch carries; `kind` "local" stands for the CLI's own profile.
 */
function fixture(t, { env = {}, kind = "managed" } = {}) {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, "claude"));
  const calls = [];
  const services = {
    config: { home: "/tmp", dataDir: "/tmp" },
    accounts: {
      verifyEndpointTarget: async () => {},
      command: () => {
        calls.push("command");
        return { command: "/bin/sh", args: [], env: { PATH: "/bin", ...env } };
      },
      hiddenLogin: (_id, launchEnv) => {
        calls.push("hidden");
        if (kind === "local") return localHidden(root, launchEnv) ? "local" : undefined;
        return managedHidden(root, launchEnv) ? "pending" : undefined;
      },
    },
    providerAccess: {
      resolve: () => ({ account: { id: "account", tool: "claude", name: "Claude" } }),
    },
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
      prepare: async ({ launch }) => launch,
      discard: async () => {},
    };
  return { root, calls, ...createSessionLifecycle(services) };
}
const sandboxed = { nonoProfile: "dev" };

test("a sandboxed launch is refused while the login is in the keychain and nothing else signs in", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.launch(sandboxed, false, { id: "s1" }), {
    message: serverMessages.sessions.sandboxLoginPending,
    status: 409,
  });
  // Asked after the launch gave the login its chance to move, and before anything
  // of the session exists.
  assert.deepEqual(f.calls, ["command", "hidden"]);
});

test("a pending account that signs in through its launch or its settings starts", async (t) => {
  for (const env of [
    { ANTHROPIC_API_KEY: "sk-test" },
    { ANTHROPIC_AUTH_TOKEN: "token" },
    { CLAUDE_CODE_OAUTH_TOKEN: "token" },
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_VERTEX: "1" },
  ]) {
    const f = fixture(t, { env });
    await f.launch(sandboxed, false, { id: "s1" });
    assert.equal(f.calls.includes("create"), true, Object.keys(env)[0]);
  }
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.root, "claude/settings.json"),
    JSON.stringify({ apiKeyHelper: "/usr/local/bin/key" }),
  );
  await f.launch(sandboxed, false, { id: "s2" });
  assert.equal(f.calls.includes("create"), true);
  // An empty variable signs nothing in.
  const empty = fixture(t, { env: { ANTHROPIC_API_KEY: "" } });
  await assert.rejects(empty.launch(sandboxed, false, { id: "s3" }), { status: 409 });
});

test("a sandboxed launch of the CLI's own profile is never refused", async (t) => {
  const f = fixture(t, { kind: "local" });
  await f.launch(sandboxed, false, { id: "s1" });
  assert.deepEqual(f.calls, ["command", "hidden", "create"]);
});

test("an unsandboxed launch is not asked at all", async (t) => {
  const f = fixture(t);
  await f.launch({}, false, { id: "s1" });
  assert.deepEqual(f.calls, ["command", "create"]);
});

test("the refusal says what to do, in both languages, and only one exists", () => {
  assert.match(english.sandboxLoginPending, /Stop the account's sessions/);
  assert.match(serverMessages.sessions.sandboxLoginPending, /Beende die Sessions/);
  assert.equal("sandboxLoginLocal" in english, false);
  assert.equal("sandboxLoginLocal" in serverMessages.sessions, false);
});

test("a profile that signs in through its settings or environment is not counted as hidden", (t) => {
  const home = temporary(t);
  const config = path.join(home, ".claude");
  fs.mkdirSync(config);
  assert.equal(localHidden(home), true);
  assert.equal(localHidden(home, { ANTHROPIC_API_KEY: "sk-test" }), false);
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
