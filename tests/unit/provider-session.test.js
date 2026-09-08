import test from "node:test";
import assert from "node:assert/strict";
import { publicProviderConfiguration } from "../../server/features/sessions/provider-configuration.js";
import { ModelController } from "../../server/features/models/model-controller.js";

test("session provider metadata excludes credentials and arbitrary catalog fields", () => {
  assert.deepEqual(
    publicProviderConfiguration({
      id: "zai",
      requestedModelId: "glm-5.3",
      contextTokens: 1000000,
      modelChangeRequiresRestart: true,
      apiKey: "private-fixture",
      raw: { token: "private-fixture" },
    }),
    {
      id: "zai",
      requestedModelId: "glm-5.3",
      contextTokens: 1000000,
      modelChangeRequiresRestart: true,
    },
  );
});

for (const operation of ["open", "select", "search"])
  test(`context-pinned provider sessions reject model ${operation} before any terminal input`, async () => {
    const commands = [];
    const sessions = {
      control: async (_id, callback) =>
        callback({
          session: {
            id: "test",
            tool: "claude",
            provider: { id: "zai", modelChangeRequiresRestart: true },
          },
          screen: async () => "",
          keys: async (keys) => commands.push(keys),
          type: async (text) => commands.push(text),
        }),
    };
    const controller = new ModelController({ sessions });
    await assert.rejects(
      controller[operation]("test", {}),
      (error) => error.status === 409 && /new session/.test(error.message),
    );
    assert.deepEqual(commands, []);
  });

test("model observation labels provider configuration separately from CLI-confirmed selection", async () => {
  const provider = {
    id: "zai",
    requestedModelId: "glm-5.3",
    assumedContextTokens: 1000000,
    modelChangeRequiresRestart: true,
  };
  const sessions = {
    control: async (_id, callback) =>
      callback({
        session: { id: "test", tool: "claude", provider },
        screen: async () => "",
      }),
  };
  const result = await new ModelController({ sessions }).read("test");
  assert.equal(result.currentModel, null);
  assert.equal(result.currentSource, null);
  assert.deepEqual(result.configuration, provider);
  assert.equal(result.modelChangeRequiresRestart, true);
});
