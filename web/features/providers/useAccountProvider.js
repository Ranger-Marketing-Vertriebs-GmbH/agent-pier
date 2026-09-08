import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useProviderCatalog from "./useProviderCatalog.js";

export default function useAccountProvider(account, tool) {
  const [open, setOpen] = useState(Boolean(account?.provider));
  const [providerId, setProviderId] = useState(account?.provider?.id || "");
  const [modelId, setModelId] = useState(account?.provider?.modelId || "");
  const [responsesAccess, setResponsesAccess] = useState(
    Boolean(account?.provider?.responsesAccess),
  );
  const [providers, setProviders] = useState([]);
  const [providerError, setProviderError] = useState("");
  const [providersLoading, setProvidersLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const catalog = useProviderCatalog(providerId, tool);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setProvidersLoading(true);
    setProviderError("");
    api("/providers", "GET", undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setProviders(data.providers || []);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setProviderError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProvidersLoading(false);
      });
    return () => controller.abort();
  }, [open, reload]);
  function chooseProvider(id) {
    setProviderId(id);
    setModelId("");
    setResponsesAccess(false);
    setQuery("");
  }
  const selectedModel = catalog.models.find((model) => model.modelId === modelId);
  const requiresResponses = tool === "codex" && providerId && providerId !== "openrouter";
  const changed =
    providerId !== (account?.provider?.id || "") ||
    Boolean(
      providerId &&
      (modelId !== account?.provider?.modelId ||
        Boolean(requiresResponses && responsesAccess) !==
          Boolean(account?.provider?.responsesAccess)),
    );
  const ready =
    Boolean(account && !changed) ||
    !providerId ||
    Boolean(selectedModel && !catalog.loading && (!requiresResponses || responsesAccess));
  const selection = providerId
    ? { id: providerId, modelId, ...(requiresResponses ? { responsesAccess } : {}) }
    : null;
  return {
    open,
    setOpen,
    providerId,
    chooseProvider,
    modelId,
    setModelId,
    responsesAccess,
    setResponsesAccess,
    providers: providers.filter((provider) => provider.tools?.includes(tool)),
    providerError,
    providersLoading,
    retryProviders: () => setReload((value) => value + 1),
    query,
    setQuery,
    catalog,
    selectedModel,
    requiresResponses,
    changed,
    ready,
    selection,
  };
}
