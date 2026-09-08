import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../../server/features/accounts/account-store.js";

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-providers-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: new AccountStore({ dataDir, home: dataDir }) };
}
const provider = { id: "openrouter", modelId: "anthropic/claude-sonnet-4.6" };

test("managed provider selection survives restart without exposing its key", (t) => {
  const { dataDir, store } = setup(t);
  const account = store.create({
    name: "Router",
    tool: "codex",
    apiKey: "private-key",
    provider,
  });
  assert.deepEqual(account.provider, provider);
  assert.deepEqual(new AccountStore({ dataDir }).get(account.id).provider, provider);
  assert.equal(JSON.stringify(store.list()).includes("private-key"), false);
  assert.equal(store.environment(account.id).OPENROUTER_API_KEY, "private-key");
  assert.equal(store.environment(account.id).OPENAI_API_KEY, undefined);
});

test("provider validation rejects UI-supplied context and unknown model IDs before storing an account", (t) => {
  const { store } = setup(t);
  for (const invalid of [
    { ...provider, contextTokens: 99999999 },
    { ...provider, modelId: "fabricated-model" },
    { ...provider, id: "constructor" },
    { ...provider, apiKey: "leak" },
  ])
    assert.throws(() => store.create({ name: "Bad", tool: "codex", provider: invalid }), {
      status: 400,
    });
  assert.equal(store.list().filter((account) => account.kind === "managed").length, 0);
});

test("key removal disables gateway launch and rotation restores it", (t) => {
  const { store } = setup(t);
  const account = store.create({
    name: "Router",
    tool: "opencode",
    apiKey: "old-key",
    provider,
  });
  store.update(account.id, { name: "Router", removeApiKey: true });
  assert.equal(store.get(account.id).hasSecret, false);
  assert.equal(store.environment(account.id).OPENROUTER_API_KEY, undefined);
  assert.throws(() => store.command(account.id, { opencode: "/bin/echo" }), {
    status: 409,
  });
  store.update(account.id, { name: "Router", apiKey: "new-key" });
  assert.equal(
    store.command(account.id, { opencode: "/bin/echo" }).env.OPENROUTER_API_KEY,
    "new-key",
  );
  assert.equal(JSON.stringify(store.get(account.id)).includes("new-key"), false);
});

test("gateway profiles cannot enter OAuth even after their key is removed", (t) => {
  const { store } = setup(t);
  const account = store.create({ name: "Router", tool: "claude", provider });
  assert.throws(() => store.command(account.id, { claude: "/bin/echo" }, true), {
    status: 409,
  });
});

test("switching providers cannot forward the previous provider's key", (t) => {
  const { store } = setup(t);
  const account = store.create({
    name: "Router",
    tool: "opencode",
    apiKey: "router-key",
    provider,
  });
  assert.throws(
    () =>
      store.update(account.id, {
        name: "Router",
        provider: { id: "zai", modelId: "glm-5.3" },
      }),
    { status: 409 },
  );
  assert.deepEqual(store.get(account.id).provider, provider);
  store.update(account.id, {
    name: "Z.ai",
    provider: { id: "zai", modelId: "glm-5.3" },
    apiKey: "zai-key",
  });
  assert.equal(store.environment(account.id).ZHIPU_API_KEY, "zai-key");
  assert.equal(store.environment(account.id).OPENROUTER_API_KEY, undefined);
});

test("gateway settings use a separate namespace from a previous native login", (t) => {
  const { store } = setup(t);
  const account = store.create({ name: "Claude", tool: "claude" });
  const native = store.environment(account.id).CLAUDE_CONFIG_DIR;
  fs.writeFileSync(path.join(native, ".credentials.json"), "personal-login");
  store.update(account.id, { name: "Gateway", provider, apiKey: "gateway-key" });
  const gateway = store.environment(account.id);
  assert.notEqual(gateway.CLAUDE_CONFIG_DIR, native);
  assert.equal(gateway.CLAUDE_CONFIG_DIR, gateway.CLAUDE_SECURESTORAGE_CONFIG_DIR);
  assert.equal(
    fs.existsSync(path.join(gateway.CLAUDE_CONFIG_DIR, ".credentials.json")),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(native, ".credentials.json"), "utf8"),
    "personal-login",
  );
});

test("switching Codex to a gateway preserves its isolated native OAuth login", (t) => {
  const { store } = setup(t);
  const account = store.create({ name: "Codex", tool: "codex" });
  const original = store.environment(account.id).CODEX_HOME;
  const credentials = {
    tokens: { access_token: "fixture-native-login" },
    OPENAI_API_KEY: null,
  };
  fs.writeFileSync(path.join(original, "auth.json"), JSON.stringify(credentials));
  store.update(account.id, { name: "Gateway", provider, apiKey: "fixture-gateway-key" });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(original, "auth.json"), "utf8")),
    credentials,
  );
  assert.notEqual(store.environment(account.id).CODEX_HOME, original);
});

test("removing a native Codex API key clears both private copies", (t) => {
  const { store } = setup(t);
  const account = store.create({
    name: "Codex",
    tool: "codex",
    apiKey: "fixture-native-key",
  });
  const profile = store.profile(account.id);
  store.update(account.id, { name: "Codex", removeApiKey: true });
  assert.equal(fs.existsSync(path.join(profile, "secret.json")), false);
  assert.equal(fs.existsSync(path.join(profile, "codex/auth.json")), false);
  assert.equal(store.environment(account.id).OPENAI_API_KEY, undefined);
});
