import { sameValue } from "../../../lib/settings/draft-state.js";
import { agentPages, agentSettingsLocation } from "../settings-routes.js";
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
  "readPdfs",
  "createImages",
];
export const webCapabilityKeys = capabilityKeys.slice(2);
export const capabilityDefaults = Object.fromEntries(
  capabilityKeys.map((key) => [key, false]),
);
// A new agent remembers by default; a saved agent's unset capability stays off.
export const createCapabilityDefaults = { ...capabilityDefaults, memory: true };
export const capabilityFormKeys = [
  ...capabilityKeys,
  "browserVisible",
  "shell",
  "skills",
];
// MCP servers are granted in the Access tab, saved with the agent's PATCH.
export const mcpKeys = ["mcpServers"];
export const profileKeys = [
  "name",
  "instructions",
  "connectionId",
  "modelId",
  "followLead",
];
export const heartbeatKeys = [
  "heartbeatEnabled",
  "interval",
  "start",
  "end",
  "timeZone",
  "heartbeatTelegram",
];
export const channelKeys = ["language", "appUrl"];
export const permissionKeys = ["memoryWrite", "autonomous", "publish"];
export const accessKeys = [
  "projectIds",
  "projectFiles",
  "sessionProjectIds",
  "pipelineIds",
  "sshAccesses",
  "github",
  "secretIds",
  ...permissionKeys,
];
// Direct folder access per granted project (server assistant-access.js projectFiles).
export const folderLevels = ["none", "read", "write"];
export const sshModes = ["approval", "trusted", "routines"];
// The team usage levels the server accepts (team-policy.js); "suggest" is its default.
export const teamUsageLevels = ["onRequest", "suggest", "autonomous"];
export const teamKeys = [
  "teamUsage",
  "teamAutonomous",
  "memberShellSsh",
  "maxMembers",
  "runTimeoutMinutes",
];

export const isPersonal = (assistant) =>
  !assistant?.teamMemberId || assistant.lifetime === "permanent";

/**
 * The tabs an agent has (handoff 5.4): a temporary member only Overview, Identity,
 * Capabilities and Access (its lead's grants, read only); permanent members and
 * agents of users have no Team tab.
 */
export function visibleAgentTabs(assistant) {
  if (!isPersonal(assistant)) return ["overview", "identity", "capabilities", "access"];
  const team = !assistant?.teamMemberId && !assistant?.userAccess;
  return [
    "overview",
    "identity",
    "capabilities",
    "access",
    ...(team ? ["team"] : []),
    "automation",
    "channels",
  ];
}

/** Whether the agent has this subpage; Telegram subpages also need a channel (tab). */
export function agentPageAllowed(assistant, page) {
  if (!page) return true;
  if (!agentPages[page]) return false;
  // A task member's own memory is always on; the owner can read it (AGENTPIER-119).
  if (page === "memory")
    return isPersonal(assistant)
      ? assistant.capabilities?.memory === true
      : !!assistant.inherited && !assistant.archivedAt;
  if (!isPersonal(assistant)) return false;
  // An agent of users never has these grants (user-agent-lock.js).
  if (assistant.userAccess && ["ssh", "github", "pipelines", "secrets"].includes(page))
    return false;
  if (page === "allowlist" || page === "skills") return shellEligible(assistant);
  return true;
}

/** The tab and subpage to show, and whether the address has to be replaced. */
export function resolveAgentLocation(assistant, route) {
  const wanted = agentSettingsLocation(route);
  const tabs = visibleAgentTabs(assistant);
  const tab = tabs.includes(wanted.tab) ? wanted.tab : "overview";
  const page =
    tab === wanted.tab && agentPageAllowed(assistant, wanted.page) ? wanted.page : "";
  return { tab, page, tabs, normalized: tab !== wanted.tab || page !== wanted.page };
}

export const agentRoute = (assistantId, tab = "overview", page = "", hook = "") => ({
  view: "agents",
  assistantId,
  agentSettings: true,
  ...(tab !== "overview" || page ? { agentTab: tab } : {}),
  ...(page ? { agentPage: page } : {}),
  ...(page && hook ? { agentHook: hook } : {}),
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
/** Folder levels sorted by project id, so the draft compares stably. */
export const sortedLevels = (levels) =>
  Object.fromEntries(
    Object.entries(levels || {})
      .filter(([, level]) => level === "read" || level === "write")
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
/** `levels` with `projectId` at `level`; "none" (or null) removes it. */
export const setFolderLevel = (levels, projectId, level) => {
  const { [projectId]: _old, ...rest } = levels || {};
  return sortedLevels(level && level !== "none" ? { ...rest, [projectId]: level } : rest);
};
export const toggleId = (ids, id, on) =>
  sortedIds(on ? [...ids, id] : ids.filter((value) => value !== id));
// The server sorts grants by access id the same way (assistant-access.js).
export const sortedGrants = (grants) =>
  (grants || [])
    .map(({ accessId, mode }) => ({ accessId, mode }))
    .sort((a, b) => (a.accessId < b.accessId ? -1 : a.accessId > b.accessId ? 1 : 0));
/** The grant list with `accessId` set to `mode`, or without it when `mode` is null. */
export function setSshGrant(grants, accessId, mode) {
  const rest = grants.filter((g) => g.accessId !== accessId);
  return sortedGrants(mode ? [...rest, { accessId, mode }] : rest);
}
/** Granted hosts that still exist, and how many of them run without asking. */
export function sshSummary(grants, hosts) {
  const known = grants.filter((g) => hosts.some((h) => h.id === g.accessId));
  return {
    count: known.length,
    trusted: known.filter((g) => g.mode !== "approval").length,
  };
}
const pick = (source, keys) =>
  Object.fromEntries(keys.map((key) => [key, source?.[key] === true]));

/** A temporary member, which may follow its lead's model or run on its own. */
export const followsLeadModel = (assistant) =>
  !!assistant?.teamMemberId && assistant.lifetime !== "permanent";
export const profileServer = (assistant) => ({
  name: assistant?.name || "",
  instructions: assistant?.instructions || "",
  connectionId: assistant?.model?.connectionId || "",
  modelId: assistant?.model?.modelId || "",
  followLead: followsLeadModel(assistant) && assistant.ownModel !== true,
});
/** Following the lead sends `followLead` instead of a model of its own. */
export const profilePatch = (values) => ({
  name: values.name,
  instructions: values.instructions,
  ...(values.followLead
    ? { followLead: true }
    : { model: { connectionId: values.connectionId, modelId: values.modelId } }),
});

export const capabilityServer = (assistant) => ({
  ...pick(assistant?.capabilities, capabilityKeys),
  browserVisible: assistant?.browserVisible === true,
  shell: shellLevel(assistant),
  skills: sortedIds(assistant?.skills),
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
  // The visible window belongs to the agent's own browser profile; an agent of users
  // runs it headless only (user-agent-lock.js).
  if (shellEligible(assistant) && !assistant.userAccess && changed("browserVisible"))
    patch.browserVisible = values.browserVisible;
  // Only a changed level is sent: the server asks to confirm a raise.
  if (shellEligible(assistant) && changed("shell")) patch.shell = values.shell;
  if (shellEligible(assistant) && changed("skills")) patch.skills = values.skills;
  // Check-ins need memory: switching memory off switches a saved schedule off too.
  if (!values.memory && assistant.heartbeat?.enabled)
    patch.heartbeat = { ...heartbeatForm(assistant), enabled: false };
  return patch;
}

/** The Routines & check-ins tab's draft: the check-in schedule. */
export function routinesServer(assistant) {
  const heartbeat = heartbeatForm(assistant);
  return {
    heartbeatEnabled: heartbeat.enabled === true,
    interval: heartbeat.interval,
    start: heartbeat.start,
    end: heartbeat.end,
    timeZone: heartbeat.timeZone,
    // Check-ins also go to a paired Telegram chat unless switched off.
    heartbeatTelegram: heartbeat.telegram !== false,
  };
}
/** The Telegram tab's draft: the notice language and AgentPier address. */
export const telegramServer = (channel) => ({
  language: channel?.language || "de",
  appUrl: channel?.appUrl ?? "",
});
// Check-ins are only sent switched on when the server would accept it: with memory.
export const heartbeatPatch = (values, assistant) => ({
  heartbeat: {
    enabled: values.heartbeatEnabled && assistant.capabilities?.memory === true,
    interval: values.interval,
    start: values.start,
    end: values.end,
    timeZone: values.timeZone,
    telegram: values.heartbeatTelegram,
  },
});
export function channelPatch({ values, base }) {
  const patch = {};
  if (values.language !== base.language) patch.language = values.language;
  if (values.appUrl !== base.appUrl) patch.appUrl = values.appUrl.trim() || null;
  return patch;
}

/** The Access tab's share of the work record: grants and permissions. */
export const accessServer = (policy) => ({
  projectIds: sortedIds(policy?.projectIds),
  projectFiles: sortedLevels(policy?.projectFiles),
  // Projects where the agent starts coding sessions without asking (server agent access).
  sessionProjectIds: sortedIds(policy?.sessionProjectIds),
  pipelineIds: sortedIds(policy?.pipelineIds),
  sshAccesses: sortedGrants(policy?.sshAccesses),
  // GitHub through a token profile (server agent-github.js), or null.
  github: policy?.github
    ? { credentialId: policy.github.credentialId, level: policy.github.level }
    : null,
  // Secrets the agent receives in .agentpier/secrets.env (server agent-secret-grants.js).
  secretIds: sortedIds(policy?.secretIds),
  memoryWrite: policy?.memoryWrite === true,
  autonomous: policy?.autonomous === true,
  publish: policy?.publish === true,
});
/** The Team tab's share: the lead's team policy. */
export const teamServer = (team) => ({
  teamUsage: teamUsageLevels.includes(team?.usage) ? team.usage : "suggest",
  teamAutonomous: team?.autonomous === true,
  memberShellSsh: team?.memberShellSsh === true,
  maxMembers: team?.maxMembers ?? "",
  runTimeoutMinutes: team?.runTimeoutMinutes ?? "",
});
export const workServer = (policy, team) => ({
  ...accessServer(policy),
  ...teamServer(team),
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

/**
 * The PUT /assistants/:id/work body: only the halves with changes, each with its
 * revision. The server keeps a half the body leaves out (assistant-work.js), so the
 * Access tab sends `access` alone and the Team tab `team` alone.
 */
export function workBody({
  values,
  changed,
  revisions,
  withAccess = true,
  withTeam,
  sshHostIds = null,
}) {
  const body = {};
  if (withAccess && accessKeys.some((key) => changed.includes(key)))
    body.access = {
      revision: revisions.access,
      ...Object.fromEntries(
        accessKeys
          .filter(
            (key) =>
              ![
                "sshAccesses",
                "projectFiles",
                "sessionProjectIds",
                "github",
                "secretIds",
              ].includes(key),
          )
          .map((key) => [key, values[key]]),
      ),
      // Coding session grants likewise; the server keeps the stored ones filtered to the
      // projects that stay granted.
      ...(changed.includes("sessionProjectIds") && {
        sessionProjectIds: values.sessionProjectIds,
      }),
      // Folder levels likewise go only when changed; the server keeps absent ones
      // for the projects that stay granted.
      ...(changed.includes("projectFiles") && { projectFiles: values.projectFiles }),
      // Only when changed: a stored access to a removed profile never fails a save.
      ...(changed.includes("github") && { github: values.github }),
      // Likewise only when changed: an unreadable secrets store never fails a save.
      ...(changed.includes("secretIds") && { secretIds: values.secretIds }),
      // Only changed grants are sent (the server keeps absent ones), so an unreadable
      // SSH catalog cannot fail other saves. Grants of removed hosts drop on save; an
      // unreadable catalog drops nothing.
      ...(changed.includes("sshAccesses") && {
        sshAccesses: sshHostIds
          ? values.sshAccesses.filter((g) => sshHostIds.includes(g.accessId))
          : values.sshAccesses,
      }),
    };
  if (withTeam && teamKeys.some((key) => changed.includes(key)))
    body.team = {
      revision: revisions.team,
      usage: values.teamUsage,
      autonomous: values.teamAutonomous,
      memberShellSsh: values.memberShellSsh,
      maxMembers: values.maxMembers,
      runTimeoutMinutes: values.runTimeoutMinutes,
    };
  return body;
}

/** Granted projects a saved Work draft dropped because they no longer exist. */
export const removedProjectCount = (result) =>
  result?.status === "saved" ? result.results.work?.removedProjectIds?.length || 0 : 0;
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
  ...createCapabilityDefaults,
  shell: "off",
});
export const createInput = (values) => ({
  ...profilePatch(values),
  capabilities: pick(values, capabilityKeys),
  ...(values.shell !== "off" ? { shell: values.shell } : {}),
});

/**
 * The projects the saved access holds (granted or with folder access). The Work tab
 * keeps an older row of a folder listed while they name it, also after unticking it
 * in the draft, so the owner can tick it again or save its removal.
 */
export const savedProjectIds = (policy) => [
  ...(policy?.projectIds || []),
  ...Object.keys(policy?.projectFiles || {}),
];
