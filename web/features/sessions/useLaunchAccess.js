import { useEffect, useState } from "react";
import useConnectionModels from "../providers/useConnectionModels.js";
import api from "../../lib/api.js";
import {
  preferredLaunchAccess,
  profileLaunchAccess,
  rememberedLaunchModel,
  rememberedLaunchTool,
} from "./launch-preferences.js";
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
// An explicit account of that CLI (a rebuild's, `initialAccess`) is preselected.
function initialChoice(state, tools, initialTool, initialProfile, initialAccess) {
  const explicit = tools.find((tool) => tool.id === initialTool)?.id;
  const remembered = initialTool ? null : rememberedLaunchTool(tools);
  const tool = explicit || remembered || tools[0]?.id || "";
  if (initialProfile)
    return {
      tool,
      toolRemembered: false,
      accessId: profileLaunchAccess(state, initialProfile.config),
      accessRemembered: false,
      accessPicked: false,
    };
  if (
    initialAccess &&
    state.accounts.some(
      (account) => account.id === initialAccess && account.tool === tool,
    )
  )
    return {
      tool,
      toolRemembered: false,
      accessId: initialAccess,
      accessRemembered: false,
      accessPicked: false,
    };
  const access = preferredLaunchAccess(state, tool);
  return {
    tool,
    toolRemembered: Boolean(remembered) && !explicit,
    accessId: access.accessId,
    accessRemembered: access.remembered,
    accessPicked: access.picked,
  };
}
export default function useLaunchAccess(
  state,
  initialTool,
  initialProfile,
  initialAccess,
) {
  const tools = state.tools.filter((tool) => tool.installed);
  const [start] = useState(() =>
    initialChoice(state, tools, initialTool, initialProfile, initialAccess),
  );
  const [tool, setTool] = useState(start.tool),
    [toolRemembered, setToolRemembered] = useState(start.toolRemembered),
    [accessId, setAccess] = useState(start.accessId),
    [accessRemembered, setAccessRemembered] = useState(start.accessRemembered),
    // The owner chose this access in the dialog (or chose it last time and kept it).
    [accessPicked, setAccessPicked] = useState(start.accessPicked),
    [modelId, setModel] = useState(
      () =>
        initialProfile?.config.models.default ||
        rememberedLaunchModel(start.tool, start.accessId),
    ),
    [nativeModelId, setNativeModel] = useState(
      initialProfile?.config.models.default || "",
    ),
    [query, setQuery] = useState(""),
    [sandboxProfiles, setSandboxProfiles] = useState([]),
    [sandboxAvailable, setSandboxAvailable] = useState(false),
    [hiddenLogins, setHiddenLogins] = useState({}),
    [nonoProfile, setNonoProfile] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api("/sandbox-profiles", "GET", undefined, controller.signal)
      .then((result) => {
        setSandboxAvailable(Boolean(result.available));
        setSandboxProfiles(result.profiles || []);
        setHiddenLogins(result.hiddenLogins || {});
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
  // A provider connection starts on the model last launched with it.
  function resetModel(nextTool, nextAccess) {
    setModel(rememberedLaunchModel(nextTool, nextAccess));
    setNativeModel("");
    setQuery("");
  }
  function chooseTool(value) {
    const preferred = preferredLaunchAccess(state, value);
    if (value !== tool) setToolRemembered(false);
    setTool(value);
    setAccess(preferred.accessId);
    setAccessRemembered(preferred.remembered);
    setAccessPicked(preferred.picked);
    resetModel(value, preferred.accessId);
  }
  // `picked` is false when the dialog itself preselects, e.g. for a task profile.
  function chooseAccess(value, picked = true) {
    setAccess(value);
    setAccessRemembered(false);
    setAccessPicked(picked);
    resetModel(tool, value);
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
    accessPicked,
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
    hiddenLogins,
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
