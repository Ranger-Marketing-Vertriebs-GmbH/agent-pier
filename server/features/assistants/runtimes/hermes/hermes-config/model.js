import { agentPierPoolSource } from "./home-merge.js";

// An agent's model connection (agent-desired-state.js `model`: { ref, providerId,
// provider, agentRuntime }) as Hermes's `model` section and the secrets its .env
// holds. Verified against Hermes v0.22.5: hermes_cli/runtime_provider_custom.py
// (`model.key_env` for a bare `provider: custom` route), hermes_cli/config.py
// (`${VAR}` references in config values), cli-config.yaml.example (`model.default`,
// `base_url`, `api_mode`, `context_length`, `extra_headers`).

// The secret of a custom OpenAI-compatible endpoint. Hermes strips every
// `AUXILIARY_<NAME>_API_KEY` from the shell, execute_code and every other child it
// spawns (tools/environments/local_env_policy.py `_is_hermes_internal_secret`), and
// reads one only for its known auxiliary tasks (hermes_cli/cli_config_load.py), so
// the agent's own commands never see the key. A free name such as
// `AGENTPIER_API_KEY` would reach them.
export const endpointKeyEnv = "AUXILIARY_AGENTPIER_API_KEY";
// OpenRouter's own key name, which Hermes's provider reads and strips alike.
export const openRouterKeyEnv = "OPENROUTER_API_KEY";
// The Codex backend URL Hermes's openai-codex provider uses instead of chatgpt.com
// (hermes_cli/runtime_provider.py `_pool_entry_mode_and_url`: it wins over every
// credential's own URL, also on a credential rotation, credential_pool.py
// `runtime_base_url`).
export const codexBaseEnv = "HERMES_CODEX_BASE_URL";
// Every .env name the compiler owns: a connection that no longer needs one removes it.
export const modelEnvNames = Object.freeze([
  endpointKeyEnv,
  openRouterKeyEnv,
  codexBaseEnv,
]);

const openRouterUrl = "https://openrouter.ai/api/v1";
const reference = (name) => `\${${name}}`;

// Request headers for an endpoint that takes its key in another header than
// `Authorization: Bearer` (assistant-provider-endpoint.js `authHeader`). An empty
// Authorization replaces the SDK's Bearer credential, as OpenClaw's compile does.
function keyHeaders(provider) {
  const header = provider.authHeader === false && provider.headers;
  if (!header) return undefined;
  const name = Object.keys(header).find((key) => key !== "authorization");
  if (!name) return { Authorization: reference(endpointKeyEnv) };
  return { Authorization: "", [name]: reference(endpointKeyEnv) };
}

/**
 * Hermes's `model` section and .env secrets for `connection`, or
 * `{ unsupported }` naming why Hermes cannot use it: "modelAccount" for a ChatGPT
 * account, "modelProtocol" for a transport other than Chat Completions. Pure.
 *
 * Every endpoint kind AgentPier offers agents (OpenAI, Azure OpenAI, Anthropic's
 * and other vendors' OpenAI-compatible APIs, Ollama, llama.cpp, LM Studio, …) is a
 * Chat Completions endpoint (assistant-provider-endpoint.js), compiled as
 * `provider: custom` with `api_mode: chat_completions`; the explicit mode keeps
 * Hermes from switching an api.openai.com or `/anthropic` URL to another wire
 * protocol (agent/agent_init.py `_resolve_api_mode`, `_finalize_routing`). The
 * endpoint's Chat Completions options need no key in Hermes v0.22.5:
 * - maxTokensField: Hermes sends no output cap on an agent's turns (the gateway's
 *   runtime carries no `max_tokens`, agent/transports/chat_completions.py
 *   `_apply_max_tokens`); where it sends one it picks `max_completion_tokens` for
 *   api.openai.com, Azure OpenAI and the GPT-4o/4.1/5 and o-series models itself
 *   (run_agent.py `_max_tokens_param`).
 * - streamUsage: Hermes asks for usage in the stream (`stream_options`) and repeats
 *   the request without it for the rest of the session once an endpoint refuses it
 *   (agent/chat_completion_helpers.py `_rejects_stream_options`).
 *
 * A ChatGPT account (`connection.chatgpt`, model-accounts.js) runs on Hermes's own
 * `openai-codex` provider, which keeps the Codex request shaping on (agent/
 * codex_responses_adapter.py `is_codex_backend` is true for that provider whatever
 * its URL; a plain `provider: custom` drops `api_mode: codex_responses` for a host
 * other than OpenAI's, runtime_provider.py `_resolve_plain_custom_api_mode`). Its
 * requests go to AgentPier's model proxy (`modelProxy.url`, HERMES_CODEX_BASE_URL),
 * which holds the account's tokens, and carry only the proxy's credential for this
 * agent, as an `api_key` row of Hermes's credential pool in auth.json (`auth`,
 * home-merge.js mergeAuth): Hermes refreshes only `oauth` rows that have a refresh
 * token (agent/credential_pool.py), so it never redeems anything; OpenAI's refresh
 * token stays with AgentPier, the only refresher. A login OpenClaw still holds
 * (`holder: "openclaw"`) has no such proxy access until the owner moves it to
 * AgentPier: "modelAccount".
 */
export function modelSection(connection, { modelProxy } = {}) {
  const section = baseSection(connection, modelProxy);
  // Hermes hands a tool's page images (pdf.js) to a model it knows sees them: a
  // custom endpoint's model is unknown to its catalog unless config.yaml says so
  // (agent/image_routing.py `_supports_vision_override`).
  if (section.images) section.section.supports_vision = true;
  return section;
}

function baseSection(connection, modelProxy) {
  if (connection?.chatgpt) return chatgptSection(connection.chatgpt, modelProxy);
  const provider = connection?.provider;
  if (!provider) return { unsupported: "modelAccount" };
  if (provider.api !== "openai-completions") return { unsupported: "modelProtocol" };
  const [model] = provider.models || [];
  if (!model?.id) return { unsupported: "modelProtocol" };
  if (provider.baseUrl === openRouterUrl)
    return {
      section: {
        provider: "openrouter",
        default: model.id,
        api_mode: "chat_completions",
      },
      env: provider.apiKey ? { [openRouterKeyEnv]: provider.apiKey } : {},
    };
  const headers = provider.apiKey ? keyHeaders(provider) : undefined;
  return {
    section: {
      provider: "custom",
      default: model.id,
      base_url: provider.baseUrl,
      api_mode: "chat_completions",
      ...(provider.apiKey && { key_env: endpointKeyEnv }),
      ...(headers && { extra_headers: headers }),
      ...(Number.isInteger(model.contextWindow) && {
        context_length: model.contextWindow,
      }),
    },
    env: provider.apiKey ? { [endpointKeyEnv]: provider.apiKey } : {},
    // Hermes sends images natively only to models it knows see them.
    images: Array.isArray(model.input) && model.input.includes("image"),
  };
}

/** The openai-codex pool row of a proxy credential (home-merge.js mergeAuth). */
export const codexPoolRow = (baseUrl, credential) => ({
  id: "agentpier",
  label: "AgentPier",
  auth_type: "api_key",
  priority: 0,
  source: agentPierPoolSource,
  access_token: credential,
  base_url: baseUrl,
});

function chatgptSection({ profileId, modelId, holder }, modelProxy) {
  const credential = modelProxy?.credentialFor?.(profileId);
  if (holder !== "agentpier" || !modelProxy?.url || !credential)
    return { unsupported: "modelAccount" };
  const baseUrl = `${modelProxy.url}/chatgpt/codex`;
  return {
    section: { provider: "openai-codex", default: modelId },
    env: { [codexBaseEnv]: baseUrl },
    auth: codexPoolRow(baseUrl, credential),
    // OpenAI's ChatGPT models see images.
    images: true,
  };
}
