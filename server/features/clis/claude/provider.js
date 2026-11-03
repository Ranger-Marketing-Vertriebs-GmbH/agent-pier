// How Claude Code runs against a provider connection (see docs/coding-clis.md). Imports
// only leaf helpers: this module is on the import graph of drivers.js.
import { configureClaudeProvider } from "../../providers/claude-provider.js";
import { ADAPTER_URL_PLACEHOLDER } from "../../providers/adapter-launch.js";
import { profileEnv } from "./profile.js";

export function environment(
  env,
  { directory, key, description, adapterRoute, adapterToken },
) {
  Object.assign(env, profileEnv(directory));
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
  return env;
}

export function launch(
  result,
  { description, secret, metadata, cliVersion, adapterRoute, endpointKind },
) {
  return configureClaudeProvider(
    result,
    metadata,
    // Probed asynchronously by the caller (accounts.command); never read here.
    cliVersion ?? null,
    {
      forceCustom: endpointKind,
      customHeader:
        endpointKind &&
        !adapterRoute &&
        !!description.auth.header &&
        !!secret?.apiKey?.trim(),
    },
  );
}
