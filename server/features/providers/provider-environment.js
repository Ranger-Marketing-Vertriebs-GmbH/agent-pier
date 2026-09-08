import path from "node:path";
import { privateDirectory } from "../../lib/storage.js";

export function providerEnvironment(account, secret, environment, root) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|OPENAI_|OPENROUTER_|ZAI_|ZHIPU_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_MAX_CONTEXT|CLAUDE_CODE_DISABLE_1M|CLAUDE_CODE_SUBAGENT_MODEL)/.test(
        key,
      ) ||
      key === "DISABLE_COMPACT"
    )
      delete env[key];
  }
  const directory = path.join(root, "providers", account.provider.id);
  const key = secret?.apiKey;
  if (account.tool === "codex") {
    env.CODEX_HOME = privateDirectory(path.join(directory, "codex"));
    if (key)
      env[account.provider.id === "openrouter" ? "OPENROUTER_API_KEY" : "ZAI_API_KEY"] =
        key;
  } else if (account.tool === "claude") {
    env.CLAUDE_CONFIG_DIR = privateDirectory(path.join(directory, "claude"));
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    env.ANTHROPIC_BASE_URL =
      account.provider.id === "openrouter"
        ? "https://openrouter.ai/api"
        : "https://api.z.ai/api/anthropic";
    env.ANTHROPIC_API_KEY = "";
    if (key) env.ANTHROPIC_AUTH_TOKEN = key;
  } else if (account.tool === "opencode") {
    for (const [name, folder] of Object.entries({
      XDG_CONFIG_HOME: "config",
      XDG_DATA_HOME: "data",
      XDG_STATE_HOME: "state",
      XDG_CACHE_HOME: "cache",
    }))
      env[name] = privateDirectory(path.join(directory, folder));
    if (key)
      env[account.provider.id === "openrouter" ? "OPENROUTER_API_KEY" : "ZHIPU_API_KEY"] =
        key;
  }
  return env;
}
