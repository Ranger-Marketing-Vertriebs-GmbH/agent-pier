// An agent's model connection (agent-desired-state.js `model`: { ref, providerId,
// provider, agentRuntime }) as Hermes's `model` section and the secrets its .env
// holds. Verified against Hermes a4994d4e: hermes_cli/runtime_provider_custom.py
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
// Every .env name the compiler owns: a connection that no longer needs one removes it.
export const modelEnvNames = Object.freeze([endpointKeyEnv, openRouterKeyEnv]);

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
 * account (Hermes keeps its own Codex login and rotating refresh token, which
 * AgentPier never shares), "modelProtocol" for a transport other than Chat
 * Completions. Pure.
 */
export function modelSection(connection) {
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
