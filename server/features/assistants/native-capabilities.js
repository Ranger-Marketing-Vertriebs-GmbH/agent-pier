export const capabilityKeys = [
  "memory",
  "reminders",
  "webSearch",
  "webFetch",
  "browser",
  "documents",
  "createImages",
];
export const capabilityTools = {
  webSearch: ["web_search"],
  webFetch: ["web_fetch"],
  browser: ["browser"],
  // `pdf` is not offered: OpenClaw needs a global agents.defaults.pdfModel (tracked
  // separately), so only image reading is granted.
  documents: ["view_image"],
  // OpenClaw's image_generate through the ChatGPT account (gpt-image-2); its results
  // reach the owner as shared files (generated-images.js).
  createImages: ["image_generate"],
};
export const webCapabilityKeys = [
  "webSearch",
  "webFetch",
  "browser",
  "documents",
  "createImages",
];
export const memoryTools = ["memory_search", "memory_get", "read", "write", "edit"];
// Writes reach the workspace only through the plugin's before_tool_call guard, which
// is verified live on these runtimes; elsewhere memory stays read-only.
export const guardedTools = ["write", "edit"];
// Tools offered only while the plugin's tool guard is proven: the guarded writes, the
// browser, whose calls the guard pins to the agent's own profile, and image creation,
// whose calls it checks and counts (image-policy.js).
export const guardGatedTools = [...guardedTools, "browser", "image_generate"];
const guardGatedCapabilities = ["browser", "createImages"];
export const writeGuardRuntimes = ["2026.9.8", "2026.9.9", "2026.10.3"];
export const delegationTools = [
  "agentpier_team_propose",
  "agentpier_team_status",
  "agentpier_team_stop",
  "agentpier_team_members",
  "agentpier_team_ask",
  "agentpier_team_delegate",
  "agentpier_team_cancel",
  "agentpier_team_archive",
  "agentpier_team_grant",
  "agentpier_team_member_update",
  "agentpier_team_promote",
];
export const shellLevels = ["off", "approval", "full"];
export const shellTools = ["exec", "process"];
// OpenClaw's session tools: they read (and can steer) other sessions of the agent,
// so an agent with its own bot for other people never gets them.
export const sessionTools = [
  "session_status",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
];
/**
 * The run-level cap of a routine (payload.toolsAllow): every tool an agent's own
 * profile can hold, so OpenClaw's intersection with the agent's tools.allow leaves
 * exactly the agent's current chat tools and a capability change needs no job
 * rewrite. Writes stay with the tool guard, which admits a routine's own run
 * (TeamBridge.routineWrite). Left out: reminders and routines (a routine never
 * schedules) and the team and workspace tools (the bridge serves them only in an
 * owner's chat turn). `agentpier_ssh` is in: the bridge admits a routine's run
 * session for SSH only on hosts marked "Trusted incl. routines", and for
 * `agentpier_share_file` into the routine's chat and Telegram. `*__*`
 * stands for the agent's MCP tools (`<server>__<tool>`).
 */
export const routineTools = [
  "session_status",
  ...memoryTools,
  ...Object.values(capabilityTools).flat(),
  ...shellTools,
  "agentpier_ssh",
  "agentpier_share_file",
  "*__*",
];
export const personalEligible = (assistant) =>
  !assistant.archivedAt &&
  (!assistant.teamMemberId || assistant.lifetime === "permanent");
/**
 * A temporary member that runs with what its lead granted it, within what the lead
 * holds right now. The store resolves `inherited` on every read (memberInheritance
 * in member-grants.js) and never stores it, so a change to the lead reaches the
 * member's next apply without copying anything.
 */
export const inheritsFromLead = (assistant) =>
  !!assistant.teamMemberId &&
  assistant.lifetime !== "permanent" &&
  !assistant.archivedAt &&
  !!assistant.inherited;
/**
 * Whether an agent has native memory: its own setting, or for a temporary member
 * always (its own writable memory; the lead's memory grant only adds the read-only
 * copy of the lead's, member-memory.js).
 */
export const memoryEnabled = (assistant) =>
  personalCapabilities(assistant).memory || inheritsFromLead(assistant);
/** The effective shell level; ineligible or unset profiles have none. */
export function personalShell(assistant) {
  if (inheritsFromLead(assistant))
    return shellLevels.includes(assistant.inherited.shell)
      ? assistant.inherited.shell
      : "off";
  return personalEligible(assistant) && shellLevels.includes(assistant.shell)
    ? assistant.shell
    : "off";
}
/**
 * The bundled skills compiled for an agent (agent-skills.js): sorted, without
 * duplicates; a temporary member's are its lead's, an archived agent has none.
 */
export function personalSkills(assistant) {
  const source = inheritsFromLead(assistant)
    ? assistant.inherited
    : personalEligible(assistant) && assistant;
  if (!source || !Array.isArray(source.skills)) return [];
  return [...new Set(source.skills.filter((name) => typeof name === "string"))].sort();
}
const ownCapabilities = (assistant, eligible = false) =>
  Object.fromEntries(
    capabilityKeys.map((key) => [
      key,
      eligible && assistant.capabilities?.[key] === true,
    ]),
  );
export function personalCapabilities(assistant) {
  if (inheritsFromLead(assistant))
    return ownCapabilities({ capabilities: assistant.inherited.capabilities }, true);
  return ownCapabilities(assistant, personalEligible(assistant));
}
/**
 * The capabilities at least one eligible profile has switched on. Temporary members
 * only ever hold a subset of their lead's, so they never widen the set.
 */
export function usedCapabilities(profiles = []) {
  const used = new Set();
  for (const profile of profiles) {
    if (inheritsFromLead(profile)) continue;
    for (const [key, on] of Object.entries(personalCapabilities(profile)))
      if (on) used.add(key);
  }
  return used;
}
export function profileTools(
  assistant,
  teamsReady,
  nativeReady,
  writeGuard = false,
  available = {},
  // `<name>__*` globs of the MCP servers bound to this agent (mcpSections).
  mcpTools = [],
  // The agent holds at least one SSH grant (assistant-access.js hasSshGrants).
  ssh = false,
) {
  const capabilities = personalCapabilities(assistant);
  // A temporary member has its own memory beside the read-only copy of its lead's,
  // and gets no routines (standing jobs with tools that would outlive the team).
  const member = inheritsFromLead(assistant);
  return [
    "session_status",
    ...(teamsReady && !assistant.teamMemberId && !assistant.archivedAt
      ? delegationTools
      : []),
    // A member writes only its own memory: the bridge refuses everything else.
    ...(nativeReady && (capabilities.memory || member)
      ? memoryTools.filter((tool) => writeGuard || !guardedTools.includes(tool))
      : []),
    ...(nativeReady && capabilities.reminders
      ? ["agentpier_reminder", ...(member ? [] : ["agentpier_routine"])]
      : []),
    // Temporary members use it only to request coding runs on the parent's grant.
    ...(nativeReady && !assistant.archivedAt ? ["agentpier_workspace"] : []),
    // Every agent may hand the owner a file from its own workspace (agent-shares.js).
    ...(nativeReady && !assistant.archivedAt ? ["agentpier_share_file"] : []),
    ...(nativeReady
      ? Object.entries(capabilityTools).flatMap(([key, tools]) =>
          // `available` withholds a tool whose browser or search provider is absent;
          // the browser also waits for the proven tool guard.
          capabilities[key] &&
          available[key] !== false &&
          (!guardGatedCapabilities.includes(key) || writeGuard)
            ? tools
            : [],
        )
      : []),
    // Paired with the entry's tools.exec override (openclaw-config/shell.js).
    ...(nativeReady && personalShell(assistant) !== "off" ? shellTools : []),
    ...(nativeReady && !assistant.archivedAt ? mcpTools : []),
    ...(nativeReady &&
    ssh &&
    (personalEligible(assistant) || (member && assistant.inherited.ssh))
      ? ["agentpier_ssh"]
      : []),
  ];
}
