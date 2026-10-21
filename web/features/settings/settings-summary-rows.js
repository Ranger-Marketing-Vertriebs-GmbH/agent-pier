import { formatTimestamp } from "../../lib/i18n/index.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { remoteCopy } from "../../lib/i18n/messages/remote.js";
import { settingsHubCopy as copy } from "../../lib/i18n/messages/settings.js";

// Rows of the Zugriff and Betrieb tabs from GET /settings/summary. `value: null`
// means "not known" (the row shows "—"); a missing value means the row has none.
const count = (part) => (Number.isSafeInteger(part?.count) ? part.count : null);

function mcpState(mcp) {
  if (!mcp) return { value: null };
  if (!mcp.available) return { status: { tone: "warn", text: copy.mcpUnavailable } };
  return { value: copy.mcpClients(mcp.activeGrants) };
}

function remoteState(remote) {
  if (!remote) return { value: null };
  // A saved network change that is not running yet: the mode shown would be wrong.
  if (remote.restartRequired)
    return { status: { tone: "warn", text: copy.remoteRestart } };
  const active = [
    remote.tailscale && remoteCopy.tailscale,
    remote.network && remoteCopy.network,
  ].filter(Boolean);
  return active.length
    ? { status: { tone: "ok", text: active.join(" · ") } }
    : { value: remoteCopy.local };
}

export function accessRows(access) {
  const label = (id) => operationsCopy.sections[id];
  return [
    { id: "mcp", label: label("mcp"), sub: copy.mcpSub, ...mcpState(access?.mcp) },
    {
      id: "remote",
      label: label("remote"),
      sub: copy.remoteSub,
      ...remoteState(access?.remote),
    },
    { id: "ssh", label: label("ssh"), sub: copy.sshSub, value: count(access?.ssh) },
    {
      id: "github",
      label: label("github"),
      sub: copy.githubSub,
      value: count(access?.github),
    },
    {
      id: "users",
      label: label("users"),
      sub: copy.usersSub,
      value: count(access?.users),
    },
  ];
}

function diagnosticsState(diagnostics) {
  if (!diagnostics) return { value: null };
  if (diagnostics.failed > 0)
    return {
      status: { tone: "error", text: copy.diagnosticsFailed(diagnostics.failed) },
    };
  if (diagnostics.warnings > 0)
    return {
      status: { tone: "warn", text: copy.diagnosticsWarnings(diagnostics.warnings) },
    };
  return { status: { tone: "ok", text: copy.diagnosticsOk } };
}

function updatesState(updates) {
  if (!updates) return { value: null };
  if (updates.available)
    return { status: { tone: "warn", text: copy.updateAvailable(updates.available) } };
  return updates.checked ? { value: copy.upToDate } : {};
}

export function operationsRows(operations) {
  const { diagnostics, backups, updates } = operations ?? {};
  const label = (id) => operationsCopy.sections[id];
  return [
    {
      id: "diagnostics",
      label: label("diagnostics"),
      sub: diagnostics?.generatedAt
        ? copy.checkedAt(formatTimestamp(diagnostics.generatedAt))
        : undefined,
      ...diagnosticsState(diagnostics),
    },
    {
      id: "backups",
      label: label("backups"),
      sub: backups?.lastAt ? copy.lastBackup(formatTimestamp(backups.lastAt)) : undefined,
      value: count(backups),
    },
    {
      id: "updates",
      label: label("updates"),
      sub: updates?.current ? copy.installedVersion(updates.current) : undefined,
      ...updatesState(updates),
    },
    { id: "audit", label: label("audit"), sub: copy.auditSub },
  ];
}
