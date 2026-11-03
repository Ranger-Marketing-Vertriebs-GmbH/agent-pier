// How Codex runs against a provider connection (see docs/coding-clis.md). Imports only
// leaf helpers: this module is on the import graph of drivers.js.
import path from "node:path";
import { tomlValue } from "../../../lib/launch-serialization.js";
import { endpointCodexLaunch } from "../../providers/endpoint-launch.js";
import { glmCodexCatalog, writeTomlConfig } from "../../providers/native-config.js";
import { CODEX_FILE_CREDENTIAL_STORES } from "../../providers/codex-credential-stores.js";
import { writePrivate } from "../../../lib/storage.js";
import { profileEnv } from "./profile.js";

export function environment(
  env,
  { directory, key, description, adapterRoute, adapterToken },
) {
  Object.assign(env, profileEnv(directory));
  if (adapterRoute) {
    if (adapterToken) env[description.auth.keyEnv] = adapterToken;
  } else if (key) env[description.auth.keyEnv] = key;
  return env;
}

export function endpointLaunch(
  result,
  { description, secret, connectionName, endpoint },
) {
  endpointCodexLaunch(result, description, secret, connectionName, { endpoint });
  return result;
}

export function catalogLaunch(result, { description, selection, model, metadata, env }) {
  const router = selection.id === "openrouter";
  const config = {
    model: model.modelId,
    model_provider: selection.id,
    ...CODEX_FILE_CREDENTIAL_STORES,
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
  return result;
}
