import test from "node:test";
import assert from "node:assert/strict";
import { fakeHermesSupervisor } from "../helpers/hermes-fake-gateway.js";
import { connectionOf } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesModels } from "../../server/features/assistants/runtimes/hermes/hermes-models.js";
import { modelSection } from "../../server/features/assistants/runtimes/hermes/hermes-config/model.js";
import {
  refuseEveryCommand,
  refuseRuntimeChoice,
} from "../../server/features/assistants/own-process-agents.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";

test("the Hermes models sub-port lists the home's inventory and signs in no account", async () => {
  const supervisor = fakeHermesSupervisor({ agentId: "ap-1" });
  const models = hermesModels(supervisor);
  // Unreachable while stopped, as every sub-port is.
  await assert.rejects(models.catalog({}), (e) => e.code === "UNAVAILABLE");
  await assert.rejects(models.status({}), (e) => e.code === "UNAVAILABLE");
  await supervisor.start();
  const catalog = await models.catalog({ refresh: true, timeoutMs: 2000 });
  assert.deepEqual(catalog.providers, [{ slug: "custom", models: ["fake-1"] }]);
  assert.equal(catalog.refreshed, true);
  const sent = supervisor.peer.frames.find((f) => f.method === "model.options");
  assert.deepEqual(sent.params, { explicit_only: true, refresh: true });
  assert.deepEqual(await models.status({ timeoutMs: 1000 }), { providers: [] });
  for (const method of ["probe", "login", "loginStep", "cancelLogin", "logout"])
    await assert.rejects(
      models[method]({ sessionId: "s1", provider: "openai" }),
      (e) => e.code === "UNSUPPORTED" && e.status === 501,
      method,
    );
  // A view bound to a replaced connection reaches nothing.
  const bound = models.on(connectionOf(supervisor.client));
  await supervisor.restart();
  await assert.rejects(bound.catalog({}), (e) => e.code === "UNAVAILABLE");
  await supervisor.stop();
});

test("Hermes compiles no ChatGPT account and needs no Chat Completions options", () => {
  // A ChatGPT account carries no provider: Hermes never gets its token.
  assert.deepEqual(modelSection({ ref: "openai/gpt-5@p", agentRuntime: {} }), {
    unsupported: "modelAccount",
  });
  const section = modelSection({
    provider: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      apiKey: "sk-test",
      models: [
        {
          id: "gpt-5",
          contextWindow: 400000,
          maxTokens: 128000,
          compat: {
            maxTokensField: "max_completion_tokens",
            supportsUsageInStreaming: false,
          },
        },
      ],
    },
  });
  // Explicit Chat Completions; the options are Hermes's own choice (model.js).
  assert.equal(section.section.api_mode, "chat_completions");
  assert.equal(section.section.provider, "custom");
  assert.equal(JSON.stringify(section.section).includes("max_tokens"), false);
});

test("a Hermes agent cannot choose a ChatGPT account; OpenClaw agents still can", () => {
  const supervisor = {};
  attachHermesFleet(supervisor, { available: () => true, runtimeOf: () => null });
  const account = { connectionId: "openclaw:abc", modelId: "gpt-5" };
  const refused = (e) => e.key === "modelAccountRuntime" && e.status === 400;
  assert.throws(
    () => refuseRuntimeChoice(supervisor, { runtime: "hermes", model: account }),
    refused,
  );
  assert.doesNotThrow(() => refuseRuntimeChoice(supervisor, { model: account }));
  assert.doesNotThrow(() =>
    refuseRuntimeChoice(supervisor, {
      runtime: "hermes",
      model: { connectionId: "c1", modelId: "m" },
    }),
  );
  assert.throws(
    () => refuseEveryCommand(supervisor, { runtime: "hermes" }, { model: account }),
    refused,
  );
});
