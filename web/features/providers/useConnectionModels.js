import { useMemo } from "react";
import useProviderCatalog from "./useProviderCatalog.js";

const refresh = async () => {};

export default function useConnectionModels(connection, tool) {
  const endpoint = connection?.providerId === "endpoint";
  const catalog = useProviderCatalog(endpoint ? "" : connection?.providerId || "", tool);
  const models = useMemo(
    () =>
      endpoint
        ? (connection.endpoint?.models || [])
            .filter((model) => model.contextTokens)
            .map((model) => ({
              providerId: "endpoint",
              modelId: model.modelId,
              label: model.label,
              contextTokens: model.contextTokens,
              routingContextTokens: null,
              outputTokens: model.outputTokens,
              tools: connection.tools,
            }))
            .filter((model) => model.tools.includes(tool))
        : null,
    [endpoint, connection, tool],
  );
  if (!endpoint) return { ...catalog, endpoint: false };
  return {
    models,
    status: null,
    loading: false,
    error: "",
    refresh,
    reloading: false,
    endpoint: true,
  };
}
