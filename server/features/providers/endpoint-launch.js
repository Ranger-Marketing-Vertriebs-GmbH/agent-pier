import path from "node:path";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { codexModelCatalog, writeTomlConfig } from "./native-config.js";

/** Codex reads the key from the environment variable named here, never from config. */
export function endpointCodexLaunch(result, description, secret, connectionName) {
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
        name: connectionName || description.displayName,
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

const PLACEHOLDER_KEY = "agentpier-endpoint";
const SDK = {
  chatCompletions: { npm: "@ai-sdk/openai-compatible", keyOption: "apiKey" },
  // The two official SDKs refuse to start without a key option (fact R4c) and send it as
  // `credentialHeader`.
  responses: {
    npm: "@ai-sdk/openai",
    keyOption: "apiKey",
    credentialHeader: "authorization",
    requiresKey: true,
  },
  // Fact R4a: authToken is sent as `Authorization: Bearer`, like Claude Code.
  messages: {
    npm: "@ai-sdk/anthropic",
    keyOption: "authToken",
    credentialHeader: "authorization",
    requiresKey: true,
  },
};

/** OpenCode resolves `{env:…}` references itself, so the key stays in the environment. */
export function endpointOpenCodeLaunch(result, description, secret, connectionName) {
  const { model, auth } = description;
  const key = secret?.apiKey?.trim();
  const cliModelId = `${description.providerKey}/${model.modelId}`;
  const reference = `{env:${auth.keyEnv}}`;
  const source = description.route?.source ?? "chatCompletions";
  const sdk = SDK[source];
  const header = auth.header?.toLowerCase();
  // An SDK that requires a key gets a fixed non-secret placeholder when none is sent as
  // such. With a custom header the SDK credential header is blanked, so only the custom
  // header carries the key.
  const keyOptions = key
    ? auth.header
      ? {
          ...(sdk.requiresKey ? { [sdk.keyOption]: PLACEHOLDER_KEY } : {}),
          headers: {
            [auth.header]: reference,
            ...(sdk.requiresKey && header !== sdk.credentialHeader
              ? { [sdk.credentialHeader]: "" }
              : {}),
          },
        }
      : { [sdk.keyOption]: reference }
    : sdk.requiresKey
      ? { [sdk.keyOption]: PLACEHOLDER_KEY }
      : {};
  // @ai-sdk/anthropic appends /messages itself, so its base ends with /v1 (fact R4b).
  const baseURL =
    source === "messages"
      ? `${description.endpoints.messages}/v1`
      : description.endpoints.responses;
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: cliModelId,
    provider: {
      [description.providerKey]: {
        npm: sdk.npm,
        name: connectionName || description.displayName,
        options: {
          baseURL,
          // The key option becomes `Authorization: Bearer`; with a custom header the key is sent
          // only there, matching the connection test and Codex.
          ...keyOptions,
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
