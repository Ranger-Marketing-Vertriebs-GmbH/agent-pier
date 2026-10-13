import { sameValue } from "../../../lib/settings/draft-state.js";
import { agentSettingsLocation } from "../settings-routes.js";
import { heartbeatForm } from "../heartbeat.js";
import { shellEligible, shellLevel } from "../shell-level.js";

// Pure rules of the agent settings page (docs/settings-pattern.md): which tabs and
// subpages an agent has, what each tab's draft holds and what a save sends.
export const capabilityKeys = [
  "memory",
  "reminders",
  "webSearch",
  "webFetch",
  "browser",
  "documents",
];
export const webCapabilityKeys = capabilityKeys.slice(2);
export const capabilityDefaults = Object.fromEntries(
  capabilityKeys.map((key) => [key, false]),
);
export const capabilityFormKeys = [...capabilityKeys, "shell", "mcpServers"];
export const profileKeys = ["name", "instructions", "connectionId", "modelId"];
export const heartbeatKeys = ["heartbeatEnabled", "interval", "start", "end", "timeZone"];
export const channelKeys = ["language", "appUrl"];
export const permissionKeys = ["memoryWrite", "autonomous", "publish"];
export const accessKeys = ["projectIds", "pipelineIds", ...permissionKeys];
export const teamKeys = ["teamAutonomous", "maxMembers", "runTimeoutMinutes"];

const pageTabs = {
  memory: "capabilities",
  allowlist: "capabilities",
  actions: "work",
  projects: "work",
  pipelines: "work",
  "telegram-activity": "telegram",
  "telegram-connection": "telegram",
};

export const isPersonal = (assistant) =>
  !assistant?.teamMemberId || assistant.lifetime === "permanent";

export const visibleAgentTabs = (assistant) =>
  isPersonal(assistant)
    ? ["profile", "capabilities", "work", "telegram"]
    : ["profile", "capabilities"];

/** Whether the agent has this subpage; Telegram subpages also need a channel (tab). */
export function agentPageAllowed(assistant, page) {
  if (!page) return true;
  if (!pageTabs[page] || !isPersonal(assistant)) return false;
  if (page === "memory") return assistant.capabilities?.memory === true;
  if (page === "allowlist") return shellEligible(assistant);
  return true;
}

/** The tab and subpage to show, and whether the address has to be replaced. */
export function resolveAgentLocation(assistant, route) {
  const wanted = agentSettingsLocation(route);
  const tabs = visibleAgentTabs(assistant);
  const tab = tabs.includes(wanted.tab) ? wanted.tab : "profile";
  const page =
    tab === wanted.tab && agentPageAllowed(assistant, wanted.page) ? wanted.page : "";
  return { tab, page, tabs, normalized: tab !== wanted.tab || page !== wanted.page };
}

export const agentRoute = (assistantId, tab = "profile", page = "") => ({
  view: "agents",
  assistantId,
  agentSettings: true,
  ...(tab !== "profile" || page ? { agentTab: tab } : {}),
  ...(page ? { agentPage: page } : {}),
});

/** A tab's draft stays on screen for navigations within the same agent and tab. */
export const staysOnAgentTab = (assistantId, tab, page) => (request) => {
  const next = request?.next;
  if (
    next?.view !== "agents" ||
    next.assistantId !== assistantId ||
    !next.agentSettings ||
    next.conversationId
  )
    return false;
  const location = agentSettingsLocation(next);
  return location.tab === tab && (page === undefined || location.page === page);
};

export const sortedIds = (ids) => [...new Set(ids || [])].sort();
export const toggleId = (ids, id, on) =>
  sortedIds(on ? [...ids, id] : ids.filter((value) => value !== id));
const pick = (source, keys) =>
  Object.fromEntries(keys.map((key) => [key, source?.[key] === true]));

export const profileServer = (assistant) => ({
  name: assistant?.name || "",
  instructions: assistant?.instructions || "",
  connectionId: assistant?.model?.connectionId || "",
  modelId: assistant?.model?.modelId || "",
});
export const profilePatch = (values) => ({
  name: values.name,
  instructions: values.instructions,
  model: { connectionId: values.connectionId, modelId: values.modelId },
});

export const capabilityServer = (assistant) => ({
  ...pick(assistant?.capabilities, capabilityKeys),
  shell: shellLevel(assistant),
  mcpServers: sortedIds(assistant?.mcpServers),
});

/** One PATCH for the Capabilities tab; only changed parts are sent. */
export function capabilityPatch({ values, base, assistant }) {
  const changed = (key) => !sameValue(values[key], base[key]);
  const patch = {};
  if (capabilityKeys.some(changed))
    patch.capabilities = {
      ...capabilityDefaults,
      ...assistant.capabilities,
      ...pick(values, capabilityKeys),
    };
  // Only a changed level is sent: the server asks to confirm a raise.
  if (shellEligible(assistant) && changed("shell")) patch.shell = values.shell;
  if (changed("mcpServers")) patch.mcpServers = values.mcpServers;
  // Check-ins need memory: switching memory off switches a saved schedule off too.
  if (!values.memory && assistant.heartbeat?.enabled)
    patch.heartbeat = { ...heartbeatForm(assistant), enabled: false };
  return patch;
}

export function telegramServer(assistant, channel) {
  const heartbeat = heartbeatForm(assistant);
  return {
    heartbeatEnabled: heartbeat.enabled === true,
    interval: heartbeat.interval,
    start: heartbeat.start,
    end: heartbeat.end,
    timeZone: heartbeat.timeZone,
    language: channel?.language || "de",
    appUrl: channel?.appUrl ?? "",
  };
}
// Check-ins are only sent switched on when the server would accept it: with memory and,
// where it is known, a paired chat (`heartbeatChannel`).
export const heartbeatPatch = (values, assistant) => ({
  heartbeat: {
    enabled:
      values.heartbeatEnabled &&
      assistant.capabilities?.memory === true &&
      assistant.heartbeatChannel !== false,
    interval: values.interval,
    start: values.start,
    end: values.end,
    timeZone: values.timeZone,
  },
});
export function channelPatch({ values, base }) {
  const patch = {};
  if (values.language !== base.language) patch.language = values.language;
  if (values.appUrl !== base.appUrl) patch.appUrl = values.appUrl.trim() || null;
  return patch;
}

export const workServer = (policy, team) => ({
  projectIds: sortedIds(policy?.projectIds),
  pipelineIds: sortedIds(policy?.pipelineIds),
  memoryWrite: policy?.memoryWrite === true,
  autonomous: policy?.autonomous === true,
  publish: policy?.publish === true,
  teamAutonomous: team?.autonomous === true,
  maxMembers: team?.maxMembers ?? "",
  runTimeoutMinutes: team?.runTimeoutMinutes ?? "",
});

// The team policy limits the server enforces (team-policy.js).
export const teamLimits = { maxMembers: [1, 8], runTimeoutMinutes: [1, 60] };

/** Team number fields that would be refused: empty, fractional or out of range. */
export const invalidTeamKeys = (values) =>
  Object.entries(teamLimits)
    .filter(([key, [min, max]]) => {
      const value = values?.[key];
      return !Number.isInteger(value) || value < min || value > max;
    })
    .map(([key]) => key);

/** The PUT /assistants/:id/work body: only the halves with changes, each with its revision. */
export function workBody({ values, changed, revisions, withTeam }) {
  const body = {};
  if (accessKeys.some((key) => changed.includes(key)))
    body.access = {
      revision: revisions.access,
      ...Object.fromEntries(accessKeys.map((key) => [key, values[key]])),
    };
  if (withTeam && teamKeys.some((key) => changed.includes(key)))
    body.team = {
      revision: revisions.team,
      autonomous: values.teamAutonomous,
      maxMembers: values.maxMembers,
      runTimeoutMinutes: values.runTimeoutMinutes,
    };
  return body;
}

export const grantCount = (ids, items) =>
  items.filter((item) => ids.includes(item.id)).length;
export const pendingCount = (actions) =>
  actions.filter((action) => action.state === "awaiting_approval").length;

export const recoveryStates = [
  "transcription_failed",
  "delivery_failed",
  "delivery_uncertain",
  "reply_unavailable",
  "model_reviewed",
  "model_uncertain",
];
export const inProgressStates = [
  "queued",
  "voice_pending",
  "transcribing",
  "dispatching",
  "running",
  "outbound",
  "delivering",
];
const needsAttention = (entry) =>
  entry.needsReview || recoveryStates.includes(entry.state);

/** Telegram inputs and notices: the ones to act on first, then the 20 newest. */
export function channelActivity(channel) {
  const entries = [...(channel?.inputs || []), ...(channel?.notifications || [])];
  const visible = [
    ...new Map(
      [
        ...entries.filter((entry) => recoveryStates.includes(entry.state)),
        ...entries.slice(-20).reverse(),
      ].map((entry) => [entry.id, entry]),
    ).values(),
  ];
  return { entries, visible, attention: entries.filter(needsAttention).length };
}

export const createServer = () => ({
  ...profileServer(),
  ...capabilityDefaults,
  shell: "off",
});
export const createInput = (values) => ({
  ...profilePatch(values),
  capabilities: pick(values, capabilityKeys),
  ...(values.shell !== "off" ? { shell: values.shell } : {}),
});
