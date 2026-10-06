import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { launchDescription } from "./launch-description.js";
import { providerEnvironment } from "./provider-environment.js";
import { configureClaudeProvider } from "./claude-provider.js";
import { glmCodexCatalog, writeTomlConfig } from "./native-config.js";
import { endpointCodexLaunch, endpointOpenCodeLaunch } from "./endpoint-launch.js";

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
  { root, catalog, cliVersion, endpoint, connectionName } = {},
) {
  if (!account.provider || account.kind !== "managed") return launch;
  const description = launchDescription(account, { catalog, endpoint });
  const { selection, model } = description;
  if (
    description.auth.required &&
    (typeof secret?.apiKey !== "string" || !secret.apiKey.trim())
  )
    throw problem(serverMessages.providers.apiKeyRequiredForAccount, 409);
  const env = providerEnvironment(account, secret, launch.env, root, description);
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
  const endpointKind = description.kind === "endpoint";
  if (account.tool === "claude")
    return configureClaudeProvider(
      result,
      metadata,
      cliVersion ?? readCliVersion(launch.command),
      {
        forceCustom: endpointKind,
        customHeader:
          endpointKind && !!description.auth.header && !!secret?.apiKey?.trim(),
      },
    );
  if (endpointKind) {
    if (account.tool === "codex")
      endpointCodexLaunch(result, description, secret, connectionName);
    else if (account.tool === "opencode")
      metadata.cliModelId = endpointOpenCodeLaunch(
        result,
        description,
        secret,
        connectionName,
      );
    Object.assign(metadata, {
      assumedContextTokens: model.contextTokens,
      contextStatus: "configured",
      contextSource: "endpoint",
      modelChangeRequiresRestart: true,
    });
    return result;
  }
  if (account.tool === "codex") {
    const router = selection.id === "openrouter";
    const config = {
      model: model.modelId,
      model_provider: selection.id,
      cli_auth_credentials_store: "file",
      model_providers: {
        [selection.id]: {
          name: description.displayName,
          wire_api: "responses",
          base_url: description.endpoints.responses,
          ...(router
            ? {
                auth: {
                  command: "sh",
                  args: ["-c", "printf '%s' \"$OPENROUTER_API_KEY\""],
                },
              }
            : { env_key: description.auth.keyEnv }),
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
            apiKey: `{env:${description.auth.keyEnv}}`,
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
      throw problem(serverMessages.providers.managedOpenCodeConfigInvalid, 409);
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
