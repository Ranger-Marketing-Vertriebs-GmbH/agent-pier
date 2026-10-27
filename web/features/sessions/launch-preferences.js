// The CLI and access the owner last launched a plain session with. Stored apart
// from the launch modes (launch-modes.js) so their entries stay as they are.
// Shape: { tool: "claude", access: { claude: "<accountId>", codex: "provider:<id>" } }
const storageKey = "agentpier.launch-preferences";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return isRecord(saved) ? saved : {};
  } catch {
    return {};
  }
}

/** The CLI of the last successful launch, or null when it is no longer installed. */
export function rememberedLaunchTool(tools) {
  const tool = readPreferences().tool;
  if (typeof tool !== "string") return null;
  return tools.some((item) => item.id === tool && item.installed !== false) ? tool : null;
}

function usableAccess(state, tool, accessId) {
  if (typeof accessId !== "string" || !accessId) return false;
  if (accessId.startsWith("provider:")) {
    const id = accessId.slice("provider:".length);
    return (state.providerConnections || []).some(
      (connection) =>
        connection.id === id &&
        connection.launchable &&
        (connection.tools || []).includes(tool),
    );
  }
  return (state.accounts || []).some(
    (account) => account.id === accessId && account.tool === tool && !account.internal,
  );
}

/**
 * The access the owner last launched this CLI with, or null when it is gone:
 * a deleted or internal account, another CLI's account, or a provider
 * connection that is missing or cannot launch any more.
 */
export function rememberedLaunchAccess(state, tool) {
  const access = readPreferences().access;
  if (!isRecord(access) || !Object.hasOwn(access, tool)) return null;
  return usableAccess(state, tool, access[tool]) ? access[tool] : null;
}

/** Configured default account, else the first account, else a launchable connection. */
export function defaultLaunchAccess(state, tool) {
  const accounts = (state.accounts || []).filter((account) => account.tool === tool);
  const connection = (state.providerConnections || []).find(
    (item) => (item.tools || []).includes(tool) && item.launchable,
  );
  return (
    accounts.find(
      (account) =>
        account.id === state.defaultAccountIds?.[tool] &&
        !account.provider &&
        !account.internal,
    )?.id ||
    accounts[0]?.id ||
    (connection ? `provider:${connection.id}` : "")
  );
}

/** The owner's last choice wins; the default only fills in when there is none. */
export function preferredLaunchAccess(state, tool) {
  const remembered = rememberedLaunchAccess(state, tool);
  return remembered
    ? { accessId: remembered, remembered: true }
    : { accessId: defaultLaunchAccess(state, tool), remembered: false };
}

/** Called after a successful plain launch, so a rejected attempt is not remembered. */
export function rememberLaunchChoice(tool, accessId) {
  if (typeof tool !== "string" || !tool) return;
  const saved = readPreferences();
  const access = isRecord(saved.access) ? { ...saved.access } : {};
  if (typeof accessId === "string" && accessId) access[tool] = accessId;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ tool, access }));
  } catch {
    // A restricted browser still launches; it just keeps the defaults next time.
  }
}
