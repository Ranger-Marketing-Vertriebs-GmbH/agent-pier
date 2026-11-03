import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { cliDriver } from "../clis/drivers.js";
import { launchDescription } from "./launch-description.js";
import { providerEnvironment } from "./provider-environment.js";
import {
  adapterBlock,
  createSessionToken,
  withLoopbackNoProxy,
} from "./adapter-launch.js";

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
  const adapterRoute = description.route?.mode === "adapter";
  const token = adapterRoute ? createSessionToken() : null;
  const env = providerEnvironment(account, secret, launch.env, root, description, {
    adapterToken: token,
  });
  if (adapterRoute) withLoopbackNoProxy(env);
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
  const result = {
    ...launch,
    args: [...launch.args],
    env,
    provider: metadata,
    ...(adapterRoute
      ? {
          adapter: adapterBlock({
            tool: account.tool,
            description,
            endpoint,
            secret,
            token,
          }),
        }
      : {}),
  };
  const endpointKind = description.kind === "endpoint";
  if (endpointKind) metadata.route = description.route;
  const driver = cliDriver(account.tool).provider;
  const ctx = {
    account,
    description,
    endpoint,
    secret,
    connectionName,
    selection,
    model,
    metadata,
    env,
    cliVersion,
    adapterRoute,
    endpointKind,
  };
  if (driver.launch) return driver.launch(result, ctx);
  if (endpointKind) {
    driver.endpointLaunch(result, ctx);
    Object.assign(metadata, {
      assumedContextTokens: model.contextTokens,
      contextStatus: "configured",
      contextSource: "endpoint",
      modelChangeRequiresRestart: true,
    });
    return result;
  }
  return driver.catalogLaunch(result, ctx);
}
