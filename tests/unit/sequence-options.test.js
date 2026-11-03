import test from "node:test";
import assert from "node:assert/strict";
import { launchStart } from "../../web/features/projects/sequence-options.js";

const state = {
  tools: [
    { id: "codex", installed: true },
    { id: "claude", installed: false },
  ],
  accounts: [
    { id: "local-codex", tool: "codex" },
    { id: "local-claude", tool: "claude" },
  ],
  providerConnections: [{ id: "pc1", tools: ["codex"] }],
};

test("launchStart returns null for an uninstalled CLI or unknown account and a config for a known one", () => {
  assert.equal(launchStart(state, null), null);
  assert.equal(launchStart(state, {}), null);
  assert.equal(launchStart(state, { tool: "claude", accountId: "local-claude" }), null);
  assert.equal(launchStart(state, { tool: "gemini", accountId: "x" }), null);
  assert.equal(launchStart(state, { tool: "codex", accountId: "gone" }), null);
  assert.equal(launchStart(state, { tool: "codex", accountId: "local-claude" }), null);
  assert.equal(launchStart(state, { tool: "codex", providerConnectionId: "pc9" }), null);
  assert.deepEqual(
    launchStart(state, { tool: "codex", accountId: "local-codex", nativeModelId: "m1" }),
    {
      config: {
        providerConnectionId: undefined,
        accountId: "local-codex",
        models: { default: "m1" },
      },
    },
  );
  assert.deepEqual(
    launchStart(state, {
      tool: "codex",
      providerConnectionId: "pc1",
      providerModelId: "gpt",
      launchMode: "yolo",
    }),
    {
      config: {
        providerConnectionId: "pc1",
        accountId: undefined,
        models: { default: "gpt" },
      },
    },
  );
  assert.deepEqual(launchStart(state, { tool: "codex", accountId: "local-codex" }), {
    config: {
      providerConnectionId: undefined,
      accountId: "local-codex",
      models: { default: "" },
    },
  });
});
