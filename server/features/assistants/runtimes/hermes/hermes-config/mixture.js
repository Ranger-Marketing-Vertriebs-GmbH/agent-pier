import { readHermesConfig } from "./home-merge.js";
import {
  endpointKeyEnv,
  openRouterKeyEnv,
  openRouterUrl,
  speaksChatCompletions,
} from "./model.js";

// Mixture of Agents (ADR 0007 decision 9; docs/hermes-runtime.md): an agent's advisor
// models (runtimeOptions.hermes.mixture, ../hermes-options.js) as Hermes's MoA preset.
// Verified against Hermes v0.22.5:
// - `model.provider: moa` with `model.default: <preset>` makes every turn a MoA run
//   (hermes_cli/runtime_provider.py `_resolve_requested_shortcuts`, agent/moa_loop.py
//   `bind_moa_runtime`); auxiliary tasks use the aggregator slot (agent/
//   auxiliary_client.py `_resolve_moa_aggregator`).
// - A slot names a provider only (agent/moa_loop.py `_slot_runtime` →
//   `resolve_runtime_provider`). `custom:<name>` reaches the named entry
//   `providers.<name> { base_url, key_env, api_mode }` alone (hermes_cli/
//   runtime_provider_custom.py `_match_new_style_provider`), so each slot gets one:
//   `provider: openrouter` would read the agent's own OPENROUTER_API_KEY or the
//   credential pool, and a bare `custom` beside `provider: moa` resolves to the
//   first entry of `providers:` (the spike of 2026-11-17 saw an advisor's key there),
//   so the aggregator is a named entry too.
// - Hermes repairs a preset at read time: a slot without provider or model is dropped
//   and an empty list is filled with its built-in openai-codex and OpenRouter models
//   (hermes_cli/moa_config.py `_normalize_preset`, `_clean_slot`), and a provider it
//   cannot resolve is called bare (`_slot_runtime`). The owner's conversation must
//   never reach a provider the owner did not choose: checkedPreset refuses any slot
//   but AgentPier's named providers with a model, and without one usable advisor no
//   preset is written at all.
// - A slot's call carries only base_url, api_key and api_mode of its entry, no
//   headers, while `model.extra_headers` would go with every auxiliary call, so
//   neither the aggregator nor an advisor may need a key header of its own.

export const presetName = "agentpier";
const modelProvider = "agentpier-model";
const advisorProvider = (n) => `agentpier-advisor-${n}`;
/** The .env name of advisor `n`'s key: an AUXILIARY_*_API_KEY Hermes hides. */
export const advisorKeyEnv = (n) => `AUXILIARY_AGENTPIER_ADVISOR_${n}_API_KEY`;
// Every advisor key name the compiler owns in .env (home-merge.js mergeEnv).
export const mixtureEnvOwned = "AUXILIARY_AGENTPIER_ADVISOR_*";
// AgentPier's own entries of `providers:`, removed with the mixture.
const ownedProviders = [modelProvider, ...[1, 2, 3].map(advisorProvider)];
const named = (provider) => `custom:${provider}`;

// How long one advisor may take, in seconds. Hermes's own default is 900 s
// (`auxiliary.moa_reference.timeout`), and a timed-out advisor is retried on the
// agent's own model (agent/auxiliary_client.py `_try_main_agent_model_fallback`),
// which could hold a turn for half an hour.
export const referenceTimeoutS = 120;

/** The preset AgentPier writes: advisors once per user turn, failures announced. */
export const mixturePreset = (references, aggregator) => ({
  enabled: true,
  fanout: "user_turn",
  degraded_reference_policy: "loud",
  reference_timeout: referenceTimeoutS,
  reference_models: references,
  aggregator,
});

/**
 * `preset`, or a TypeError when any slot is not one of AgentPier's named providers
 * (`custom:agentpier-…`, an entry of `providers`) with a non-empty model, or when it
 * has no advisor: Hermes would complete such a preset with its built-in providers.
 */
export function checkedPreset(preset, providers) {
  const slots = [...(preset.reference_models || []), preset.aggregator];
  const ours = (slot) =>
    typeof slot?.provider === "string" &&
    ownedProviders.some((name) => slot.provider === named(name) && providers[name]) &&
    typeof slot.model === "string" &&
    slot.model.trim() !== "";
  if (!preset.reference_models?.length || !slots.every(ours))
    throw new TypeError(
      "A Mixture of Agents preset with a slot Hermes would repair is never written.",
    );
  return preset;
}

// The named entry and .env secret of one slot from an AgentPier connection's provider
// (assistant-models.js), with the key under `keyEnv`; null for a connection Hermes
// cannot reach as one: a ChatGPT account, another protocol, a key in a header of its
// own, no model.
function slotEntry(provider, keyEnv) {
  if (!speaksChatCompletions(provider)) return null;
  if (provider.authHeader === false || provider.headers) return null;
  const model = provider.models?.[0]?.id;
  if (typeof model !== "string" || !model.trim() || !provider.baseUrl) return null;
  return {
    model,
    entry: {
      base_url: provider.baseUrl,
      api_mode: "chat_completions",
      ...(provider.apiKey && { key_env: keyEnv }),
    },
    env: provider.apiKey ? { [keyEnv]: provider.apiKey } : {},
  };
}

// The aggregator: the agent's own model connection, under its own key name.
function aggregatorEntry(model) {
  if (!model || model.chatgpt) return null;
  const provider = model.provider;
  const keyEnv = provider?.baseUrl === openRouterUrl ? openRouterKeyEnv : endpointKeyEnv;
  return slotEntry(provider, keyEnv);
}

// Removal of AgentPier's part of a mixture written earlier: the preset, its entries
// of `providers:`, and that section when only AgentPier's entries are left in it.
function removal(existing) {
  let config = {};
  try {
    config = readHermesConfig(existing);
  } catch {
    /* An unreadable file is refused by the merge itself. */
  }
  const providers = config.providers;
  const others =
    providers && typeof providers === "object"
      ? Object.keys(providers).filter((name) => !ownedProviders.includes(name))
      : [];
  return [
    [["moa"], undefined],
    ...(providers && typeof providers === "object" && !others.length
      ? [[["providers"], undefined]]
      : ownedProviders.map((name) => [["providers", name], undefined])),
  ];
}

/**
 * The mixture of `agent` (a desiredAgent with its live apply's `model` and
 * `optionConnections`) over the model section `section` compiled today (model.js):
 * `{ section, config, env, unsupported }`. With at least one usable advisor and an
 * aggregator Hermes reaches as a named provider: `section` is `provider: moa` with
 * every other key the agent's model needs kept, `config` the named providers and the
 * preset, `env` the advisors' keys. Otherwise `section` is unchanged and `config`
 * removes what an earlier mixture wrote. `unsupported`: "mixtureAdvisor" when a stored
 * advisor is left out, "mixture" when advisors are stored but the aggregator cannot
 * act. `existing` is the home's config.yaml as found. Pure.
 */
export function mixtureHome(agent, section, existing) {
  const stored = agent.runtimeOptions?.mixture?.advisors || [];
  const off = (unsupported = []) => ({
    section,
    config: removal(existing),
    env: {},
    unsupported,
  });
  if (!stored.length) return off();
  const resolved = agent.optionConnections || [];
  const providers = {};
  const references = [];
  const env = {};
  stored.forEach((advisor, index) => {
    const n = index + 1;
    const found = resolved.find(
      (entry) =>
        entry.connectionId === advisor.connectionId && entry.modelId === advisor.modelId,
    );
    const slot =
      found && !found.unavailable && slotEntry(found.provider, advisorKeyEnv(n));
    if (!slot) return;
    providers[advisorProvider(n)] = slot.entry;
    references.push({ provider: named(advisorProvider(n)), model: slot.model });
    Object.assign(env, slot.env);
  });
  const leftOut = references.length < stored.length ? ["mixtureAdvisor"] : [];
  const aggregator = aggregatorEntry(agent.model);
  if (!aggregator) return off(["mixture"]);
  if (!references.length) return off(leftOut);
  const all = { [modelProvider]: aggregator.entry, ...providers };
  let preset;
  try {
    preset = checkedPreset(
      mixturePreset(references, {
        provider: named(modelProvider),
        model: aggregator.model,
      }),
      all,
    );
  } catch {
    return off(["mixture"]);
  }
  return {
    section: { ...section, provider: "moa", default: presetName },
    config: [
      // An advisor removed since: its entry goes, the others are replaced in place.
      ...ownedProviders
        .filter((name) => !all[name])
        .map((name) => [["providers", name], undefined]),
      ...Object.entries(all).map(([name, entry]) => [["providers", name], entry]),
      [
        ["moa"],
        {
          default_preset: presetName,
          save_traces: false,
          presets: { [presetName]: preset },
        },
      ],
    ],
    env,
    unsupported: leftOut,
  };
}
