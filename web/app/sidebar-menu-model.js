// The Menü popover (handoff §5.1, variant A): its entries in the groups Arbeiten and
// Einrichten, the area a route belongs to, and the status hint of each entry. Hints
// come only from data the app already has or reads once when the menu opens; a source
// that is unknown or failed yields no hint, never a made-up zero.
import { canonicalRoute } from "./route-redirects.js";
import {
  visibleSections,
  flaggedIds,
} from "../features/connections/connection-categories.js";

export const menuGroups = [
  {
    id: "work",
    entries: [
      { id: "overview", icon: "grid" },
      { id: "projects", icon: "folder" },
      { id: "pipelines", icon: "refresh" },
      { id: "files", icon: "history" },
      { id: "artifacts", icon: "file" },
    ],
  },
  {
    id: "setup",
    entries: [
      // Shown while agents are off too: it leads to the page that turns them on.
      { id: "agents", icon: "users" },
      { id: "clis", icon: "terminal" },
      { id: "connections", icon: "link" },
      { id: "settings", icon: "settings" },
    ],
  },
];

const areaViews = {
  projects: "projects",
  pipelines: "pipelines",
  files: "files",
  artifacts: "artifacts",
  coding: "clis",
  connections: "connections",
  settings: "settings",
};

/**
 * The menu entry a route belongs to, or "" (sessions, the inbox, an agent's chat).
 * Old addresses count as their new place, so /settings/ssh marks Zugänge.
 */
export function menuArea(input, selected) {
  const route = input && canonicalRoute(input);
  if (!route) return "";
  if (route.view === "workspace") return selected || route.sessionId ? "" : "overview";
  if (route.view === "agents") {
    // The hub, the wizard and an agent's settings; chats and browsers are sidebar rows.
    const chat = route.assistantId && !route.agentSettings;
    return chat ? "" : "agents";
  }
  return areaViews[route.view] ?? "";
}

const known = (value) => Number.isSafeInteger(value) && value >= 0;

/** Projekte: runs waiting for a decision, else failed runs (`total` of each listing). */
export function projectsHint({ decisions, failed } = {}) {
  if (known(decisions) && decisions > 0) return { kind: "decisions", count: decisions };
  if (known(failed) && failed > 0) return { kind: "failed", count: failed };
  return null;
}

/** Pipelines: running runs. */
export const pipelinesHint = (running) =>
  known(running) && running > 0 ? { kind: "running", count: running } : null;

/**
 * Agenten: "aus" while agents are off; "Dienst gestoppt" when the agent service is
 * stopped or failed; "Update bereit" when an OpenClaw update is available or prepared.
 * `feature` is `{ loading, enabled, unknown }` (unknown: the switch could not be
 * read, which is not "off"); `runtime` the loaded agents' runtime (null until known);
 * `updates` the runtime update status read when the menu opened (null if not).
 */
export function agentsHint({ feature, runtime, updates } = {}) {
  if (!feature || feature.loading) return null;
  if (!feature.enabled) return feature.unknown ? null : { kind: "agentsOff" };
  if (runtime && ["disabled", "failed"].includes(runtime.availability))
    return { kind: "agentsStopped" };
  if (updates && (updates.updateAvailable === true || updates.candidateReady === true))
    return { kind: "agentsUpdate" };
  return null;
}

/** CLIs & Erweiterungen: CLIs below their minimum version and a browser update. */
export function clisHint({ ready, tools, utilities } = {}) {
  if (!ready || !Array.isArray(tools)) return null;
  const count =
    tools.filter((tool) => tool.installed && tool.versionStatus === "update-required")
      .length +
    (Array.isArray(utilities) ? utilities : []).filter(
      (tool) => tool.installed && tool.updateAvailable === true,
    ).length;
  return count > 0 ? { kind: "cliUpdates", count } : null;
}

/**
 * Zugänge: entries with a problem or warning (GET /connections/problems) over the
 * categories Zugänge shows, as its own counts do. Native CLI accounts are no Zugänge
 * entries, so their model checks do not count.
 */
export function connectionsHint({ problems, agentsEnabled, cliAccountIds = [] } = {}) {
  if (!problems || typeof problems !== "object") return null;
  const native = new Set(cliAccountIds);
  let count = 0;
  for (const section of visibleSections(agentsEnabled === true)) {
    const ids = flaggedIds(problems, section);
    if (!ids) continue;
    for (const id of ids) if (section !== "models" || !native.has(id)) count++;
  }
  return count > 0 ? { kind: "problems", count } : null;
}

/** Einstellungen: a newer AgentPier release found by the last update check. */
export const settingsHint = (summary) =>
  summary?.operations?.updates?.available ? { kind: "appUpdate" } : null;

// Hints that ask for attention; the others only inform (Pipelines running).
const warnKinds = new Set([
  "decisions",
  "failed",
  "agentsStopped",
  "agentsUpdate",
  "cliUpdates",
  "problems",
  "appUpdate",
]);
export const hintTone = (hint) => (warnKinds.has(hint?.kind) ? "warn" : "neutral");

/** The hint text of `hint` from `copy` (sidebarCopy.hints). */
export function hintText(hint, copy) {
  if (!hint) return "";
  const entry = copy[hint.kind];
  return typeof entry === "function" ? entry(hint.count) : entry;
}
