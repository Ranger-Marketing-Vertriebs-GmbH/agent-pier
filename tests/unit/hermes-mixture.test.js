import test from "node:test";
import assert from "node:assert/strict";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import {
  checkedPreset,
  mixturePreset,
} from "../../server/features/assistants/runtimes/hermes/hermes-config/mixture.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";

// Mixture of Agents on Hermes (ADR 0007, step 7a; hermes_cli/moa_config.py of the
// pinned 0.22.5): advisors are named providers `agentpier-advisor-<n>`, the agent's
// own model the aggregator `agentpier-model`, the preset `agentpier`. Hermes repairs
// a broken slot with its built-in providers, so AgentPier never writes one.
const endpoint = (id, key = `sk-${id}`, extra = {}) => ({
  baseUrl: `https://${id}.example.test/v1`,
  api: "openai-completions",
  ...(key && { apiKey: key }),
  models: [{ id: `${id}-model`, name: `${id} model`, contextWindow: 64000 }],
  ...extra,
});
const openRouter = (modelId, key = "sk-or-advisor") => ({
  baseUrl: "https://openrouter.ai/api/v1",
  api: "openai-completions",
  apiKey: key,
  models: [{ id: modelId, name: modelId }],
});
const own = {
  ref: "ap-c1/main-model",
  providerId: "ap-c1",
  provider: endpoint("main"),
  agentRuntime: undefined,
};
const profile = (advisors, extra = {}) => ({
  id: "a1",
  name: "Agent",
  runtimeAgentId: "ap-a1",
  runtime: "hermes",
  model: { connectionId: "c1", modelId: "main-model" },
  capabilities: { memory: true },
  ...(advisors && { runtimeOptions: { hermes: { mixture: { advisors } } } }),
  ...extra,
});
const resolved = (connectionId, modelId, provider) => ({
  connectionId,
  modelId,
  ref: `ap-${connectionId}/${modelId}`,
  providerId: `ap-${connectionId}`,
  provider,
  display: { connection: connectionId, model: modelId },
});
const two = [
  { connectionId: "c-or", modelId: "openai/gpt-x" },
  { connectionId: "c-lab", modelId: "lab-model" },
];
const twoResolved = [
  resolved("c-or", "openai/gpt-x", openRouter("openai/gpt-x")),
  resolved("c-lab", "lab-model", endpoint("lab")),
];
const home = (stored, connections, options = {}, model = own) =>
  compileHome(desiredAgent(stored, { model, optionConnections: connections }), options);
const configOf = (compiled) => readHermesConfig(compiled.files["config.yaml"]);
// What the home names about the mixture among what it cannot serve.
const reasons = (compiled) =>
  compiled.unsupported.filter((reason) => reason.startsWith("mixture"));

test("without advisors the home is exactly today's", () => {
  const before = home(profile(), undefined);
  for (const variant of [
    home(profile(), []),
    home(profile([]), []),
    home(profile(undefined, { runtimeOptions: { hermes: {} } }), []),
    // Another runtime's options never reach Hermes's compiler.
    home(profile(undefined, { runtimeOptions: { openclaw: { mixture: {} } } }), []),
  ]) {
    assert.equal(variant.files["config.yaml"], before.files["config.yaml"]);
    assert.equal(variant.files[".env"], before.files[".env"]);
    assert.deepEqual(variant.unsupported, before.unsupported);
  }
  assert.equal(before.files["config.yaml"].includes("moa"), false);
});

test("two advisors compile into named providers, a preset and provider moa", () => {
  const compiled = home(profile(two), twoResolved);
  const config = configOf(compiled);
  assert.deepEqual(config.model, {
    provider: "moa",
    default: "agentpier",
    base_url: "https://main.example.test/v1",
    api_mode: "chat_completions",
    key_env: "AUXILIARY_AGENTPIER_API_KEY",
    context_length: 64000,
  });
  assert.deepEqual(config.providers, {
    "agentpier-model": {
      base_url: "https://main.example.test/v1",
      api_mode: "chat_completions",
      key_env: "AUXILIARY_AGENTPIER_API_KEY",
    },
    "agentpier-advisor-1": {
      base_url: "https://openrouter.ai/api/v1",
      api_mode: "chat_completions",
      key_env: "AUXILIARY_AGENTPIER_ADVISOR_1_API_KEY",
    },
    "agentpier-advisor-2": {
      base_url: "https://lab.example.test/v1",
      api_mode: "chat_completions",
      key_env: "AUXILIARY_AGENTPIER_ADVISOR_2_API_KEY",
    },
  });
  assert.deepEqual(config.moa, {
    default_preset: "agentpier",
    save_traces: false,
    presets: {
      agentpier: {
        enabled: true,
        fanout: "user_turn",
        degraded_reference_policy: "loud",
        reference_models: [
          { provider: "custom:agentpier-advisor-1", model: "openai/gpt-x" },
          { provider: "custom:agentpier-advisor-2", model: "lab-model" },
        ],
        aggregator: { provider: "custom:agentpier-model", model: "main-model" },
      },
    },
  });
  // Each key lives in the home's .env under a name Hermes hides from the agent's
  // commands (AUXILIARY_*_API_KEY), never in config.yaml.
  const env = compiled.files[".env"];
  assert.match(env, /^AUXILIARY_AGENTPIER_ADVISOR_1_API_KEY='sk-or-advisor'$/m);
  assert.match(env, /^AUXILIARY_AGENTPIER_ADVISOR_2_API_KEY='sk-lab'$/m);
  assert.match(env, /^AUXILIARY_AGENTPIER_API_KEY='sk-main'$/m);
  assert.equal(compiled.files["config.yaml"].includes("sk-"), false);
  assert.deepEqual(reasons(compiled), []);
});

test("an OpenRouter agent model is the aggregator with its own key name", () => {
  const model = {
    ref: "ap-c1/x/y",
    providerId: "ap-c1",
    provider: openRouter("x/y", "sk-or-own"),
    agentRuntime: undefined,
  };
  const config = configOf(home(profile(two), twoResolved, {}, model));
  assert.deepEqual(config.providers["agentpier-model"], {
    base_url: "https://openrouter.ai/api/v1",
    api_mode: "chat_completions",
    key_env: "OPENROUTER_API_KEY",
  });
  assert.deepEqual(config.moa.presets.agentpier.aggregator, {
    provider: "custom:agentpier-model",
    model: "x/y",
  });
  // A keyless local endpoint needs no key name.
  const local = home(profile([{ connectionId: "c-loc", modelId: "loc-model" }]), [
    resolved("c-loc", "loc-model", endpoint("loc", null)),
  ]);
  assert.deepEqual(configOf(local).providers["agentpier-advisor-1"], {
    base_url: "https://loc.example.test/v1",
    api_mode: "chat_completions",
  });
  assert.equal(local.files[".env"].includes("ADVISOR"), false);
});

test("an advisor that is not available is left out, keeping the others' numbers", () => {
  const compiled = home(profile(two), [
    { connectionId: "c-or", modelId: "openai/gpt-x", unavailable: "provider" },
    twoResolved[1],
  ]);
  const config = configOf(compiled);
  assert.deepEqual(Object.keys(config.providers).sort(), [
    "agentpier-advisor-2",
    "agentpier-model",
  ]);
  assert.deepEqual(config.moa.presets.agentpier.reference_models, [
    { provider: "custom:agentpier-advisor-2", model: "lab-model" },
  ]);
  assert.deepEqual(reasons(compiled), ["mixtureAdvisor"]);
  // A ChatGPT login, another protocol or a key in its own header never advises.
  for (const provider of [
    undefined,
    { ...endpoint("x"), api: "openai-responses" },
    { ...endpoint("x"), authHeader: false, headers: { "api-key": "k" } },
  ]) {
    const left = home(profile([two[0]]), [{ ...twoResolved[0], provider }]);
    assert.equal(configOf(left).model.provider, "custom", "none left: MoA is off");
    assert.equal("moa" in configOf(left), false);
    assert.deepEqual(reasons(left), ["mixtureAdvisor"]);
  }
  // A connection the apply did not resolve at all is left out as well.
  const missing = home(profile([two[0]]), []);
  assert.equal("moa" in configOf(missing), false);
});

test("an aggregator Hermes cannot reach as a named provider keeps MoA off", () => {
  const account = {
    ref: "openai/gpt-x@p",
    agentRuntime: undefined,
    chatgpt: { profileId: "p", modelId: "gpt-x", holder: "agentpier" },
  };
  const proxy = { url: "http://127.0.0.1:9", credentialFor: () => "proxy-credential" };
  const chatgpt = home(profile(two), twoResolved, { modelProxy: proxy }, account);
  assert.equal(configOf(chatgpt).model.provider, "openai-codex");
  assert.equal("moa" in configOf(chatgpt), false);
  assert.equal("providers" in configOf(chatgpt), false);
  assert.deepEqual(reasons(chatgpt), ["mixture"]);
  const azure = {
    ...own,
    provider: endpoint("az", "k", { authHeader: false, headers: { "api-key": "k" } }),
  };
  const header = home(profile(two), twoResolved, {}, azure);
  assert.equal("moa" in configOf(header), false);
  assert.ok(configOf(header).model.extra_headers, "the model stays as today");
});

test("removing the advisors removes the preset, the providers and their keys", () => {
  const withMixture = home(profile(two), twoResolved);
  const existing = {
    "config.yaml": withMixture.files["config.yaml"].replace(
      "providers:\n",
      "providers:\n  mine:\n    base_url: https://mine.example.test/v1\n",
    ),
    ".env": `${withMixture.files[".env"]}OTHER='kept'\n`,
  };
  const off = home(profile([]), [], { existing });
  const config = configOf(off);
  assert.equal("moa" in config, false);
  assert.deepEqual(config.providers, {
    mine: { base_url: "https://mine.example.test/v1" },
  });
  assert.equal(config.model.provider, "custom");
  assert.equal(off.files[".env"].includes("ADVISOR"), false);
  assert.match(off.files[".env"], /^OTHER='kept'$/m);
  // With no provider of the owner's left, the section goes with AgentPier's.
  const clean = home(profile([]), [], {
    existing: { "config.yaml": withMixture.files["config.yaml"] },
  });
  assert.equal("providers" in configOf(clean), false);
  assert.equal(
    clean.files["config.yaml"],
    home(profile(), undefined).files["config.yaml"],
  );
  // A start that does not know the model leaves the whole mixture as it is.
  const bare = compileHome(desiredAgent(profile(two)), {
    existing: { "config.yaml": withMixture.files["config.yaml"] },
  });
  assert.deepEqual(configOf(bare).moa, configOf(withMixture).moa);
});

test("a preset is only ever written with AgentPier's named providers", () => {
  const providers = {
    "agentpier-model": { base_url: "https://m.example.test/v1" },
    "agentpier-advisor-1": { base_url: "https://a.example.test/v1" },
  };
  const good = mixturePreset([{ provider: "custom:agentpier-advisor-1", model: "a" }], {
    provider: "custom:agentpier-model",
    model: "m",
  });
  assert.equal(checkedPreset(good, providers), good);
  const slot = (provider, model = "x") => ({ provider, model });
  for (const [references, aggregator] of [
    [[slot("custom:nope")], slot("custom:agentpier-model")],
    [[slot("openrouter")], slot("custom:agentpier-model")],
    [[slot("custom:agentpier-advisor-1")], slot("custom")],
    [[slot("custom:agentpier-advisor-1", "")], slot("custom:agentpier-model")],
    [[slot("custom:agentpier-advisor-1")], slot("custom:agentpier-model", " ")],
    [[slot("custom:agentpier-advisor-3")], slot("custom:agentpier-model")],
    [[], slot("custom:agentpier-model")],
    [[slot("moa")], slot("custom:agentpier-model")],
  ])
    assert.throws(
      () => checkedPreset(mixturePreset(references, aggregator), providers),
      /never written/,
    );
});
