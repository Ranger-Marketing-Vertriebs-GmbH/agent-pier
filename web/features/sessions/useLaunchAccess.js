import { useEffect, useState } from "react";
import useConnectionModels from "../providers/useConnectionModels.js";
import api from "../../lib/api.js";
import { preferredLaunchAccess, rememberedLaunchTool } from "./launch-preferences.js";
export function launchAccesses(state, tool) {
  return {
    accounts: state.accounts.filter((account) => account.tool === tool),
    connections: (state.providerConnections || []).filter((connection) =>
      connection.tools.includes(tool),
    ),
  };
}
// An explicit CLI (per-CLI "new" action or task profile) keeps its CLI; a plain
// "new session" starts with the CLI of the last successful launch if still installed.
function initialChoice(state, tools, initialTool, initialProfile) {
  const explicit = tools.find((tool) => tool.id === initialTool)?.id;
  const remembered = initialTool ? null : rememberedLaunchTool(tools);
  const tool = explicit || remembered || tools[0]?.id || "";
  if (initialProfile)
    return {
      tool,
      toolRemembered: false,
      accessId: initialProfile.config.providerConnectionId
        ? `provider:${initialProfile.config.providerConnectionId}`
        : initialProfile.config.accountId,
      accessRemembered: false,
    };
  const access = preferredLaunchAccess(state, tool);
  return {
    tool,
    toolRemembered: Boolean(remembered) && !explicit,
    accessId: access.accessId,
    accessRemembered: access.remembered,
  };
}
export default function useLaunchAccess(state, initialTool, initialProfile) {
  const tools = state.tools.filter((tool) => tool.installed);
  const [start] = useState(() =>
    initialChoice(state, tools, initialTool, initialProfile),
  );
  const [tool, setTool] = useState(start.tool),
    [toolRemembered, setToolRemembered] = useState(start.toolRemembered),
    [accessId, setAccess] = useState(start.accessId),
    [accessRemembered, setAccessRemembered] = useState(start.accessRemembered),
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
  const catalog = useConnectionModels(connection, tool),
    selectedModel = catalog.models.find((model) => model.modelId === modelId);
  function resetModel() {
    setModel("");
    setNativeModel("");
    setQuery("");
  }
  function chooseTool(value) {
    const preferred = preferredLaunchAccess(state, value);
    if (value !== tool) setToolRemembered(false);
    setTool(value);
    setAccess(preferred.accessId);
    setAccessRemembered(preferred.remembered);
    resetModel();
  }
  function chooseAccess(value) {
    setAccess(value);
    setAccessRemembered(false);
    resetModel();
  }
  const ready = Boolean(
    tools.some((item) => item.id === tool) &&
    (account || (connection?.launchable && selectedModel && !catalog.loading)),
  );
  return {
    tools,
    tool,
    toolRemembered,
    accessRemembered,
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
