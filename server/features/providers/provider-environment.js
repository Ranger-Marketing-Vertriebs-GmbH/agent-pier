import path from "node:path";
import { privateDirectory } from "../../lib/storage.js";
import { ADAPTER_URL_PLACEHOLDER } from "./adapter-launch.js";

export function providerEnvironment(
  account,
  secret,
  environment,
  root,
  description,
  { adapterToken } = {},
) {
  const adapterRoute = description.route?.mode === "adapter";
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|OPENAI_|OPENROUTER_|ZAI_|ZHIPU_|AGENTPIER_ENDPOINT_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_MAX_CONTEXT|CLAUDE_CODE_DISABLE_1M|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)/.test(
        key,
      ) ||
      key === "DISABLE_COMPACT"
    )
      delete env[key];
  }
  const directory = path.join(root, "providers", account.provider.id);
  const key = secret?.apiKey?.trim() || null;
  if (account.tool === "codex") {
    env.CODEX_HOME = privateDirectory(path.join(directory, "codex"));
    if (adapterRoute) {
      if (adapterToken) env[description.auth.keyEnv] = adapterToken;
    } else if (key) env[description.auth.keyEnv] = key;
  } else if (account.tool === "claude") {
    env.CLAUDE_CONFIG_DIR = privateDirectory(path.join(directory, "claude"));
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    if (adapterRoute) {
      // The launcher substitutes the placeholder once the adapter is bound; the CLI only
      // ever holds the session token, never the upstream key.
      if (adapterToken) env.ANTHROPIC_BASE_URL = ADAPTER_URL_PLACEHOLDER;
      env.ANTHROPIC_API_KEY = "";
      env.ANTHROPIC_AUTH_TOKEN = adapterToken || "agentpier-endpoint";
      env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
      return env;
    }
    if (description.endpoints.messages)
      env.ANTHROPIC_BASE_URL = description.endpoints.messages;
    env.ANTHROPIC_API_KEY = "";
    if (description.kind === "catalog") {
      if (key) env.ANTHROPIC_AUTH_TOKEN = key;
    } else {
      // Without its own messages URL Claude Code would talk to the default Anthropic
      // origin, so the endpoint key is only handed over together with that URL.
      const endpointKey = description.endpoints.messages ? key : null;
      if (endpointKey && !description.auth.header) env.ANTHROPIC_AUTH_TOKEN = endpointKey;
      else {
        // Claude Code refuses to start without a token; the endpoint ignores this one.
        env.ANTHROPIC_AUTH_TOKEN = "agentpier-endpoint";
        if (endpointKey)
          env.ANTHROPIC_CUSTOM_HEADERS = `${description.auth.header}: ${endpointKey}`;
      }
    }
  } else if (account.tool === "opencode") {
    for (const [name, folder] of Object.entries({
      XDG_CONFIG_HOME: "config",
      XDG_DATA_HOME: "data",
      XDG_STATE_HOME: "state",
      XDG_CACHE_HOME: "cache",
    }))
      env[name] = privateDirectory(path.join(directory, folder));
    if (key) env[description.auth.keyEnv] = key;
  }
  return env;
}
