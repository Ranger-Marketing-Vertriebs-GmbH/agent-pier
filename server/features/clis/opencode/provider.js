// How OpenCode runs against a provider connection (see docs/coding-clis.md). Imports
// only leaf helpers: this module is on the import graph of drivers.js.
import path from "node:path";
import { serverMessages } from "../../../lib/i18n/de.js";
import { problem, readJSON, writePrivate } from "../../../lib/storage.js";
import { endpointOpenCodeLaunch } from "../../providers/endpoint-launch.js";
import { profileEnv } from "./profile.js";

export function environment(env, { directory, key, description }) {
  Object.assign(env, profileEnv(directory));
  if (key) env[description.auth.keyEnv] = key;
  return env;
}

export function endpointLaunch(
  result,
  { description, secret, connectionName, metadata },
) {
  metadata.cliModelId = endpointOpenCodeLaunch(
    result,
    description,
    secret,
    connectionName,
  );
  return result;
}

export function catalogLaunch(result, { description, selection, model, metadata, env }) {
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
  return result;
}
