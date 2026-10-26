import test from "node:test";
import assert from "node:assert/strict";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";
import {
  keyChangeRequired,
  nativeAccountBody,
  nativeAccountStep,
  nativeAccountValues,
} from "../../web/features/coding/accounts/native-account-save.js";

const tools = [
  { id: "shell", installed: true },
  { id: "codex", installed: true },
];
const legacy = {
  id: "legacy-gateway",
  name: "Gateway",
  tool: "codex",
  kind: "managed",
  hasSecret: true,
  provider: { id: "zai-coding-plan", modelId: "m" },
};

test("a new account picks the first non-shell tool and sends tool and key", () => {
  const values = { ...nativeAccountValues(null, tools), name: " Arbeit ", apiKey: "k" };
  assert.equal(values.tool, "codex");
  assert.deepEqual(nativeAccountBody(values, null), {
    name: "Arbeit",
    tool: "codex",
    apiKey: "k",
  });
});

test("an edit sends the provider only when it changed", () => {
  const values = nativeAccountValues(legacy, tools);
  assert.deepEqual(nativeAccountBody(values, legacy), { name: "Gateway" });
  const selection = { id: "openrouter", modelId: "x" };
  assert.deepEqual(nativeAccountBody({ ...values, provider: { selection } }, legacy), {
    name: "Gateway",
    provider: selection,
  });
  assert.deepEqual(
    nativeAccountBody({ ...values, provider: { selection: null } }, legacy),
    { name: "Gateway", provider: null },
  );
  assert.deepEqual(nativeAccountBody({ ...values, removeApiKey: true }, legacy), {
    name: "Gateway",
    removeApiKey: true,
  });
});

test("switching the provider of an account with a key requires a new key", () => {
  const values = nativeAccountValues(legacy, tools);
  assert.equal(keyChangeRequired(values, legacy, "zai-coding-plan"), false);
  assert.equal(keyChangeRequired(values, legacy, "openrouter"), true);
  assert.equal(
    keyChangeRequired({ ...values, apiKey: "n" }, legacy, "openrouter"),
    false,
  );
  assert.equal(
    keyChangeRequired({ ...values, removeApiKey: true }, legacy, "openrouter"),
    false,
  );
});

test("the step posts or patches and reports the result", async () => {
  const calls = [];
  const request = async (path, method, body) => {
    calls.push({ path, method, body });
    return { id: "managed-1" };
  };
  for (const account of [null, legacy]) {
    const values = { ...nativeAccountValues(account, tools), name: "Team" };
    const result = await runSaveChain({
      steps: [
        nativeAccountStep({ account, label: "Save", request, saved: async () => {} }),
      ],
      values,
      base: nativeAccountValues(account, tools),
    });
    assert.equal(result.status, "saved");
  }
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["POST /accounts", "PATCH /accounts/legacy-gateway"],
  );
});
