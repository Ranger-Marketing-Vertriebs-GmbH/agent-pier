import path from "node:path";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { codexModelCatalog, writeTomlConfig } from "./native-config.js";

/** Codex reads the key from the environment variable named here, never from config. */
export function endpointCodexLaunch(result, description, secret) {
  const { model, auth } = description;
  const key = secret?.apiKey?.trim();
  const env = result.env;
  const config = {
    model: model.modelId,
    model_provider: description.providerKey,
    cli_auth_credentials_store: "file",
    model_context_window: model.contextTokens,
    model_catalog_json: path.join(env.CODEX_HOME, "models.json"),
    model_providers: {
      [description.providerKey]: {
        name: description.displayName,
        base_url: description.endpoints.responses,
        wire_api: "responses",
        requires_openai_auth: false,
        ...(key && !auth.header ? { env_key: auth.keyEnv } : {}),
        ...(key && auth.header
          ? { env_http_headers: { [auth.header]: auth.keyEnv } }
          : {}),
      },
    },
  };
  writePrivate(
    config.model_catalog_json,
    codexModelCatalog(model, {
      contextTokens: model.contextTokens,
      description: "Custom endpoint model",
      reasoning: false,
    }),
  );
  writeTomlConfig(path.join(env.CODEX_HOME, "config.toml"), config);
  for (const [name, value] of Object.entries(config))
    result.args.push("-c", `${name}=${tomlValue(value)}`);
  result.args.push("--model", model.modelId);
  return config;
}

/** OpenCode resolves `{env:…}` references itself, so the key stays in the environment. */
export function endpointOpenCodeLaunch(result, description, secret, connectionName) {
  const { model, auth } = description;
  const key = secret?.apiKey?.trim();
  const cliModelId = `${description.providerKey}/${model.modelId}`;
  const reference = `{env:${auth.keyEnv}}`;
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: cliModelId,
    provider: {
      [description.providerKey]: {
        npm: "@ai-sdk/openai-compatible",
        name: connectionName || description.displayName,
        options: {
          baseURL: description.endpoints.chatCompletions,
          ...(key ? { apiKey: reference } : {}),
          ...(key && auth.header ? { headers: { [auth.header]: reference } } : {}),
        },
        models: {
          [model.modelId]: {
            name: model.label,
            limit: { context: model.contextTokens, output: model.outputTokens },
          },
        },
      },
    },
  };
  const file = path.join(result.env.XDG_CONFIG_HOME, "opencode/opencode.json");
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
  result.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  result.args.push("--model", cliModelId);
  return cliModelId;
}
