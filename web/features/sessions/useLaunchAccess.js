import { useEffect, useState } from "react";
import useProviderCatalog from "../providers/useProviderCatalog.js";
import api from "../../lib/api.js";
export function launchAccesses(state, tool) {
  return {
    accounts: state.accounts.filter((account) => account.tool === tool),
    connections: (state.providerConnections || []).filter((connection) =>
      connection.tools.includes(tool),
    ),
  };
}
function defaultAccess(state, tool) {
  const { accounts, connections } = launchAccesses(state, tool);
  return (
    accounts.find(
      (account) =>
        account.id === state.defaultAccountIds?.[tool] &&
        !account.provider &&
        !account.internal,
    )?.id ||
    accounts[0]?.id ||
    (connections.find((connection) => connection.hasSecret)
      ? `provider:${connections.find((connection) => connection.hasSecret).id}`
      : "")
  );
}
export default function useLaunchAccess(state, initialTool, initialProfile) {
  const tools = state.tools.filter((tool) => tool.installed);
  const initial = tools.find((tool) => tool.id === initialTool)?.id || tools[0]?.id || "";
  const [tool, setTool] = useState(initial),
    [accessId, setAccess] = useState(() =>
      initialProfile
        ? initialProfile.config.providerConnectionId
          ? `provider:${initialProfile.config.providerConnectionId}`
          : initialProfile.config.accountId
        : defaultAccess(state, initial),
    ),
    [modelId, setModel] = useState(initialProfile?.config.models.default || ""),
    [nativeModelId, setNativeModel] = useState(
      initialProfile?.config.models.default || "",
    ),
    [query, setQuery] = useState(""),
    [sandboxProfiles, setSandboxProfiles] = useState([]),
    [sandboxAvailable, setSandboxAvailable] = useState(false),
    [nonoProfile, setNonoProfile] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api("/sandbox-profiles", "GET", undefined, controller.signal)
      .then((result) => {
        setSandboxAvailable(Boolean(result.available));
        setSandboxProfiles(result.profiles || []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const { accounts, connections } = launchAccesses(state, tool);
  const account = accounts.find((account) => account.id === accessId),
    connection = connections.find(
      (connection) => `provider:${connection.id}` === accessId,
    );
  const catalog = useProviderCatalog(connection?.providerId || "", tool),
    selectedModel = catalog.models.find((model) => model.modelId === modelId);
  function resetModel() {
    setModel("");
    setNativeModel("");
    setQuery("");
  }
  function chooseTool(value) {
    setTool(value);
    setAccess(defaultAccess(state, value));
    resetModel();
  }
  function chooseAccess(value) {
    setAccess(value);
    resetModel();
  }
  const ready = Boolean(
    tools.some((item) => item.id === tool) &&
    (account || (connection?.hasSecret && selectedModel && !catalog.loading)),
  );
  return {
    tools,
    tool,
    accounts,
    connections,
    account,
    connection,
    accessId,
    chooseTool,
    chooseAccess,
    modelId,
    setModel,
    nativeModelId,
    setNativeModel,
    query,
    setQuery,
    catalog,
    selectedModel,
    ready,
    sandboxProfiles,
    sandboxAvailable,
    nonoProfile,
    setNonoProfile,
    body: connection
      ? { tool, providerConnectionId: connection.id, providerModelId: modelId }
      : {
          accountId: account?.id,
          ...(tool !== "shell"
            ? {
                tool,
                ...(nativeModelId.trim() && !account?.provider
                  ? { nativeModelId: nativeModelId.trim() }
                  : {}),
              }
            : {}),
        },
  };
}
