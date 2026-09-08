import path from "node:path";
import { spawnSync } from "node:child_process";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { validateProviderSelection } from "./provider-definitions.js";
import { providerEnvironment } from "./provider-environment.js";
import { configureClaudeProvider } from "./claude-provider.js";
import { glmCodexCatalog, writeTomlConfig } from "./native-config.js";

export function readCliVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 32768,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
  });
  return result.status === 0 ? /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] || null : null;
}

export function prepareProviderLaunch(
  account,
  secret,
  launch,
  { root, catalog, cliVersion } = {},
) {
  if (!account.provider || account.kind !== "managed") return launch;
  const selection = validateProviderSelection(account.provider, account.tool, catalog);
  if (typeof secret?.apiKey !== "string" || !secret.apiKey.trim())
    throw problem("Add a provider API key before starting this account.", 409);
  const model = catalog.get(selection.id, selection.modelId, { tool: account.tool });
  const env = providerEnvironment(account, secret, launch.env, root);
  const metadata = {
    ...model,
    id: selection.id,
    requestedModelId: selection.modelId,
    effectiveModelId: null,
    cliModelId: selection.modelId,
    assumedContextTokens: null,
    contextStatus: "native-catalog",
    modelChangeRequiresRestart: false,
  };
  const result = { ...launch, args: [...launch.args], env, provider: metadata };
  if (account.tool === "claude")
    return configureClaudeProvider(
      result,
      metadata,
      cliVersion ?? readCliVersion(launch.command),
    );
  if (account.tool === "codex") {
    const router = selection.id === "openrouter";
    const config = {
      model: model.modelId,
      model_provider: selection.id,
      cli_auth_credentials_store: "file",
      model_providers: {
        [selection.id]: {
          name: router ? "OpenRouter" : "Z.ai",
          wire_api: "responses",
          base_url: router ? "https://openrouter.ai/api/v1" : "https://api.z.ai/api/v1",
          ...(router
            ? {
                auth: {
                  command: "sh",
                  args: ["-c", "printf '%s' \"$OPENROUTER_API_KEY\""],
                },
              }
            : { env_key: "ZAI_API_KEY" }),
        },
      },
    };
    if (router) {
      const context =
        model.contextTokens && model.routingContextTokens
          ? Math.min(model.contextTokens, model.routingContextTokens)
          : model.contextTokens || model.routingContextTokens;
      if (context) {
        config.model_context_window = context;
        Object.assign(metadata, {
          assumedContextTokens: context,
          contextStatus: "configured",
          contextSource: model.source,
          modelChangeRequiresRestart: true,
        });
      }
    } else {
      config.model_catalog_json = path.join(env.CODEX_HOME, "models.json");
      config.model_context_window = model.codexContextTokens;
      config.model_reasoning_effort = "high";
      writePrivate(config.model_catalog_json, glmCodexCatalog(model));
      Object.assign(metadata, {
        assumedContextTokens: model.codexContextTokens,
        contextStatus: "configured",
        contextSource: model.codexContextSource,
        modelChangeRequiresRestart: true,
      });
    }
    writeTomlConfig(path.join(env.CODEX_HOME, "config.toml"), config);
    for (const [key, value] of Object.entries(config))
      result.args.push("-c", `${key}=${tomlValue(value)}`);
    result.args.push("--model", model.modelId);
  } else if (account.tool === "opencode") {
    const cliModelId = `${selection.id}/${model.modelId}`;
    const context =
      model.routingContextTokens && model.contextTokens
        ? Math.min(model.routingContextTokens, model.contextTokens)
        : model.routingContextTokens || model.contextTokens;
    const limit = {
      ...(context ? { context } : {}),
      ...(model.outputTokens ? { output: model.outputTokens } : {}),
    };
    const file = path.join(env.XDG_CONFIG_HOME, "opencode/opencode.json");
    const config = {
      $schema: "https://opencode.ai/config.json",
      model: cliModelId,
      provider: {
        [selection.id]: {
          options: {
            apiKey:
              selection.id === "openrouter"
                ? "{env:OPENROUTER_API_KEY}"
                : "{env:ZHIPU_API_KEY}",
          },
          models: {
            [model.modelId]: {
              name: model.label,
              ...(Object.keys(limit).length ? { limit } : {}),
            },
          },
        },
      },
    };
    let current;
    try {
      current = readJSON(file, {});
    } catch {
      throw problem(
        "The managed OpenCode config is invalid. Repair it before launching.",
        409,
      );
    }
    writePrivate(file, {
      ...current,
      ...config,
      provider: { ...current.provider, ...config.provider },
    });
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    result.args.push("--model", cliModelId);
    Object.assign(metadata, {
      cliModelId,
      assumedContextTokens: context,
      contextStatus: context ? "configured" : "native-catalog",
    });
  }
  return result;
}
