// The CLI, access and folder the owner last launched a session with. Stored apart
// from the launch modes (launch-modes.js) so their entries stay as they are.
// Shape: { tool: "claude", access: { claude: "<accountId>", codex: "provider:<id>" },
//          picked: { claude: true }, cwd: "/path/to/project" }
// `picked` marks an access the owner chose in the dialog rather than a preselection.
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

/** The host's own CLI login (~/.claude, ~/.codex), not an account AgentPier manages. */
export function isLocalAccount(account) {
  return account?.kind === "local";
}

function usableAccess(state, tool, accessId, picked) {
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
  const account = (state.accounts || []).find(
    (item) => item.id === accessId && item.tool === tool && !item.internal,
  );
  // A local account counts only when the owner picked it: one that was merely
  // preselected before managed accounts were preferred must not stick.
  return Boolean(account) && (picked || !isLocalAccount(account));
}

/**
 * The access the owner last launched this CLI with, or null when it is gone:
 * a deleted or internal account, another CLI's account, or a provider
 * connection that is missing or cannot launch any more, or a local account the
 * owner did not pick.
 */
export function rememberedLaunchAccess(state, tool) {
  const access = readPreferences().access;
  if (!isRecord(access) || !Object.hasOwn(access, tool)) return null;
  return usableAccess(state, tool, access[tool], rememberedPick(tool))
    ? access[tool]
    : null;
}

/** Whether the remembered access for this CLI was the owner's own pick. */
function rememberedPick(tool) {
  const picked = readPreferences().picked;
  return isRecord(picked) && Object.hasOwn(picked, tool) && picked[tool] === true;
}

/**
 * Configured default account, else the first managed account, else the local
 * account (the host's own CLI login), else a launchable connection.
 */
export function defaultLaunchAccess(state, tool) {
  const accounts = (state.accounts || []).filter(
    (account) => account.tool === tool && !account.internal,
  );
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
    accounts.find((account) => !isLocalAccount(account) && !account.provider)?.id ||
    accounts[0]?.id ||
    (connection ? `provider:${connection.id}` : "")
  );
}

/** The owner's last choice wins; the default only fills in when there is none. */
export function preferredLaunchAccess(state, tool) {
  const remembered = rememberedLaunchAccess(state, tool);
  return remembered
    ? { accessId: remembered, remembered: true, picked: rememberedPick(tool) }
    : { accessId: defaultLaunchAccess(state, tool), remembered: false, picked: false };
}

function savePreferences(next) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // A restricted browser still launches; it just keeps the defaults next time.
  }
}

/**
 * Called after a successful plain launch, so a rejected attempt is not remembered.
 * `picked` says the owner chose this access in the dialog.
 */
export function rememberLaunchChoice(
  tool,
  accessId,
  { picked = false, modelId = "" } = {},
) {
  if (typeof tool !== "string" || !tool) return;
  const saved = readPreferences();
  const access = isRecord(saved.access) ? { ...saved.access } : {};
  const picks = isRecord(saved.picked) ? { ...saved.picked } : {};
  const models = isRecord(saved.models) ? { ...saved.models } : {};
  if (typeof accessId === "string" && accessId) {
    access[tool] = accessId;
    if (picked) picks[tool] = true;
    else delete picks[tool];
    // A provider connection's model, per CLI and connection.
    if (accessId.startsWith("provider:") && typeof modelId === "string" && modelId)
      models[modelKey(tool, accessId)] = modelId;
  }
  savePreferences({
    ...(typeof saved.cwd === "string" ? { cwd: saved.cwd } : {}),
    tool,
    access,
    picked: picks,
    ...(Object.keys(models).length ? { models } : {}),
  });
}

const modelKey = (tool, accessId) => `${tool} ${accessId}`;

/** The model last launched with this CLI on this provider connection, or "". */
export function rememberedLaunchModel(tool, accessId) {
  if (typeof accessId !== "string" || !accessId.startsWith("provider:")) return "";
  const models = readPreferences().models;
  const key = modelKey(tool, accessId);
  return isRecord(models) && Object.hasOwn(models, key) && typeof models[key] === "string"
    ? models[key]
    : "";
}

/** The folder of the last successful launch, or null. */
export function rememberedLaunchFolder() {
  const cwd = readPreferences().cwd;
  return typeof cwd === "string" && cwd.startsWith("/") ? cwd : null;
}

/** Called after a successful launch from the dialog's working-folder field. */
export function rememberLaunchFolder(cwd) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return;
  savePreferences({ ...readPreferences(), cwd });
}

/**
 * The access a task profile preselects. A profile on the host's local login (the
 * seeded profiles use it) takes a managed account of its CLI when one exists;
 * the owner can still pick the local login in the dialog.
 */
export function profileLaunchAccess(state, config) {
  if (config.providerConnectionId) return `provider:${config.providerConnectionId}`;
  const account = (state.accounts || []).find((item) => item.id === config.accountId);
  if (!isLocalAccount(account)) return config.accountId;
  const preferred = defaultLaunchAccess(state, config.cliTool);
  return preferred && !preferred.startsWith("provider:") ? preferred : config.accountId;
}
