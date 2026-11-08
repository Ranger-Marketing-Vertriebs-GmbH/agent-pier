import test from "node:test";
import assert from "node:assert/strict";
import { fakeHermesSupervisor } from "../helpers/hermes-fake-gateway.js";
import { connectionOf } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesModels } from "../../server/features/assistants/runtimes/hermes/hermes-models.js";
import { modelSection } from "../../server/features/assistants/runtimes/hermes/hermes-config/model.js";
import { mergeAuth } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
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

test("a Hermes agent cannot choose a ChatGPT login OpenClaw holds; one AgentPier holds it can", () => {
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
  const accounts = {
    holderOf: (id) => (id === "openclaw:abc" ? "agentpier" : "openclaw"),
  };
  assert.doesNotThrow(() =>
    refuseRuntimeChoice(supervisor, { runtime: "hermes", model: account }, accounts),
  );
  assert.throws(
    () =>
      refuseEveryCommand(
        supervisor,
        { runtime: "hermes" },
        { model: { connectionId: "openclaw:old", modelId: "gpt-5" } },
        accounts,
      ),
    refused,
  );
});

test("a ChatGPT login AgentPier holds compiles to the openai-codex provider behind the proxy", () => {
  const modelProxy = {
    url: "http://127.0.0.1:4999",
    credentialFor: (profileId) => `apx1.cred-${profileId}`,
  };
  const chatgpt = { profileId: "openai:o@example.invalid", modelId: "gpt-5.4" };
  const held = modelSection(
    { chatgpt: { ...chatgpt, holder: "agentpier" } },
    { modelProxy },
  );
  // Hermes hands its models images (a pdf tool's pages, hermes-config/pdf.js).
  assert.deepEqual(held.section, {
    provider: "openai-codex",
    default: "gpt-5.4",
    supports_vision: true,
  });
  assert.deepEqual(held.env, {
    HERMES_CODEX_BASE_URL: "http://127.0.0.1:4999/chatgpt/codex",
  });
  assert.equal(held.auth.auth_type, "api_key");
  assert.equal(held.auth.access_token, "apx1.cred-openai:o@example.invalid");
  assert.equal(held.auth.source, "manual:agentpier");
  assert.equal(held.images, true);
  // OpenClaw's own login, or no proxy: nothing Hermes could reach.
  for (const [connection, options] of [
    [{ chatgpt: { ...chatgpt, holder: "openclaw" } }, { modelProxy }],
    [{ chatgpt: { ...chatgpt, holder: "agentpier" } }, {}],
  ])
    assert.deepEqual(modelSection(connection, options), { unsupported: "modelAccount" });
});

test("auth.json keeps Hermes's own rows and status and replaces only AgentPier's row", () => {
  const entry = {
    id: "agentpier",
    auth_type: "api_key",
    source: "manual:agentpier",
    access_token: "apx1.a",
    base_url: "http://127.0.0.1:1/chatgpt/codex",
  };
  assert.equal(mergeAuth(undefined, null), undefined);
  const first = JSON.parse(mergeAuth(undefined, entry));
  assert.deepEqual(first.credential_pool["openai-codex"], [entry]);
  assert.equal(first.version, 1);
  const hermes = {
    version: 1,
    providers: { nous: { token: "x" } },
    active_provider: "nous",
    credential_pool: {
      "openai-codex": [
        { ...entry, last_status: "ok" },
        { id: "own", source: "device_code" },
      ],
    },
  };
  const text = JSON.stringify(hermes);
  // Hermes's status on the same row is no change.
  assert.equal(mergeAuth(text, entry), text);
  const renewed = JSON.parse(mergeAuth(text, { ...entry, access_token: "apx1.b" }));
  assert.equal(renewed.credential_pool["openai-codex"][0].access_token, "apx1.b");
  assert.deepEqual(renewed.credential_pool["openai-codex"][1], {
    id: "own",
    source: "device_code",
  });
  assert.deepEqual(renewed.providers, hermes.providers);
  assert.equal(renewed.active_provider, "nous");
  const removed = JSON.parse(mergeAuth(text, null));
  assert.deepEqual(removed.credential_pool["openai-codex"], [
    { id: "own", source: "device_code" },
  ]);
  assert.equal(mergeAuth("not json", entry), "not json");
});
