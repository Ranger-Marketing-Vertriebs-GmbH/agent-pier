import {
  PROVIDERS,
  TOOL_PROTOCOL,
  validateProviderSelection,
} from "./provider-definitions.js";
import { endpointModel } from "./endpoint-config.js";
import { resolveRoute } from "./endpoint-routing.js";

/** Where and how a provider account connects, without validating its model. */
export function launchTarget(account, endpoint) {
  const definition = PROVIDERS[account.provider?.id];
  if (definition?.kind === "endpoint")
    return {
      kind: "endpoint",
      providerKey: "agentpier-endpoint",
      displayName: "Custom endpoint",
      endpoints: {
        messages: endpoint?.anthropicBaseUrl || null,
        responses: endpoint?.openaiBaseUrl || null,
        chatCompletions: endpoint?.openaiBaseUrl || null,
      },
      auth: {
        keyEnv: "AGENTPIER_ENDPOINT_API_KEY",
        header: endpoint?.authHeader || null,
        required: false,
      },
      route: endpoint ? resolveRoute(endpoint, account.tool) : null,
    };
  return {
    kind: "catalog",
    providerKey: definition.id,
    displayName: definition.codexName,
    endpoints: { ...definition.endpoints, chatCompletions: null },
    auth: {
      keyEnv: definition.keyEnv[account.tool] || null,
      header: null,
      required: true,
    },
    route: { mode: "native", source: TOOL_PROTOCOL[account.tool] },
  };
}

export function launchDescription(account, { catalog, endpoint }) {
  const selection = validateProviderSelection(account.provider, account.tool, catalog, {
    endpoint,
  });
  const target = launchTarget(account, endpoint);
  return {
    ...target,
    selection,
    model:
      target.kind === "endpoint"
        ? endpointModel(endpoint, selection.modelId, account.tool)
        : catalog.get(selection.id, selection.modelId, { tool: account.tool }),
  };
}
