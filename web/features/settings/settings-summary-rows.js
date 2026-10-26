import { formatTimestamp } from "../../lib/i18n/index.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { settingsHubCopy as copy } from "../../lib/i18n/messages/settings.js";
import { agentsHubRoute } from "../assistants/hub-routes.js";
import { codingRoute } from "../coding/routes.js";
import { connectionsRoute } from "../connections/routes.js";
import { statusBytes } from "../dashboard/system-status-format.js";

// Rows of the Allgemein and Betrieb tabs from GET /settings/summary. `value: null`
// means "not known" (the row shows "—"); a missing value means the row has none.
const count = (part) => (Number.isSafeInteger(part?.count) ? part.count : null);

function mcpState(mcp) {
  if (!mcp) return { value: null };
  if (!mcp.available) return { status: { tone: "warn", text: copy.mcpUnavailable } };
  return { value: copy.mcpClients(mcp.activeGrants) };
}

// "Umgezogen" in Allgemein: where the former Einstellungen pages live now. Shown for two
// releases after 2.7.0: remove the group (and its copy) in 2.9.0.
export function movedRows(access) {
  return [
    {
      id: "agents",
      label: copy.movedAgents,
      sub: copy.movedAgentsSub,
      route: agentsHubRoute("runtime"),
    },
    {
      id: "connections",
      label: copy.movedConnections,
      sub: copy.movedConnectionsSub,
      route: connectionsRoute(),
    },
    {
      id: "mcp",
      label: copy.movedMcp,
      sub: copy.movedMcpSub,
      route: codingRoute("mcp"),
      ...mcpState(access?.mcp),
    },
  ];
}

/** Betrieb › Speicher: the free disk space from GET /system-status, "—" until known. */
export function storageRow(status) {
  const free = status?.disk?.freeBytes;
  return {
    id: "storage",
    label: operationsCopy.sections.storage,
    sub: copy.storageSub,
    value:
      Number.isFinite(free) && free >= 0 ? copy.storageFree(statusBytes(free)) : null,
  };
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
