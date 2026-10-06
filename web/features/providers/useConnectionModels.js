import { useMemo } from "react";
import useProviderCatalog from "./useProviderCatalog.js";

const refresh = async () => {};

export default function useConnectionModels(connection, tool) {
  const endpoint = connection?.providerId === "endpoint";
  const catalog = useProviderCatalog(endpoint ? "" : connection?.providerId || "", tool);
  const all = useMemo(
    () =>
      endpoint
        ? (connection.endpoint?.models || [])
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
  // The server refuses models without a context size, so they stay unselectable.
  const models = useMemo(() => all?.filter((model) => model.contextTokens), [all]);
  const unavailableModels = useMemo(
    () => all?.filter((model) => !model.contextTokens) || [],
    [all],
  );
  if (!endpoint) return { ...catalog, endpoint: false };
  return {
    models,
    unavailableModels,
    status: null,
    loading: false,
    error: "",
    refresh,
    reloading: false,
    endpoint: true,
  };
}
