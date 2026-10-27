// "Needs you" on the start page (tests/unit/start-attention.test.js): what waits for
// a decision (the Inbox, in its order) and what the host needs, from the sources the
// menu hints read, the system status and the workspace state.

/** How many cards show before "n more"; phones show the same as compact rows. */
export const ATTENTION_LIMIT = 3;

/**
 * The system items, most pressing first: an unreachable service, low disk, a stopped
 * agent service, each CLI below its minimum version, each browser update, Zugänge
 * with problems, an AgentPier update and sessions on the old tmux server. `hints` are
 * the menu hints (useHintsOf); `status` the system status summary (null: unknown);
 * `legacyTmux` the sessions on the old tmux server (from the workspace state).
 */
export function systemAttention({
  serviceError = false,
  status = null,
  hints = {},
  tools = [],
  utilities = [],
  ready = false,
  appVersion = null,
  legacyTmux = [],
}) {
  const items = [];
  if (serviceError) items.push({ id: "service", kind: "serviceError" });
  if (status?.warning?.diskLow)
    items.push({
      id: "disk",
      kind: "diskLow",
      freePercent: status.disk?.freePercent,
      thresholdPercent: status.warning.thresholdPercent,
    });
  if (hints.agents?.kind === "agentsStopped")
    items.push({ id: "agents", kind: "agentsStopped" });
  if (ready) {
    for (const tool of tools)
      if (tool.installed && tool.versionStatus === "update-required")
        items.push({ id: `cli:${tool.id}`, kind: "cliUpdate", tool });
    for (const tool of utilities)
      if (tool.installed && tool.updateAvailable === true)
        items.push({ id: `browser:${tool.id}`, kind: "browserUpdate", tool });
  }
  if (hints.connections?.kind === "problems")
    items.push({
      id: "connections",
      kind: "connections",
      count: hints.connections.count,
    });
  if (hints.settings?.kind === "appUpdate")
    items.push({ id: "app", kind: "appUpdate", version: appVersion });
  if (Array.isArray(legacyTmux) && legacyTmux.length)
    items.push({ id: "legacy-tmux", kind: "legacyTmux", sessions: legacyTmux });
  return items;
}

/**
 * Every card: the inbox items (as `{ id, kind: "inbox", item }`) in the Inbox's order,
 * then the system items. `total` counts them for the header; null while neither the
 * inbox nor any system item is known, so the header never shows an invented zero.
 */
export function attentionItems({ inbox, system }) {
  const waiting = Array.isArray(inbox)
    ? inbox.map((item) => ({ id: `inbox:${item.type}:${item.id}`, kind: "inbox", item }))
    : [];
  const items = [...waiting, ...system];
  return { items, total: Array.isArray(inbox) || system.length ? items.length : null };
}
