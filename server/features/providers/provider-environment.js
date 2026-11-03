import path from "node:path";
import { cliDriver } from "../clis/drivers.js";

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
  return cliDriver(account.tool).provider.environment(env, {
    directory,
    key,
    description,
    adapterRoute,
    adapterToken,
  });
}
