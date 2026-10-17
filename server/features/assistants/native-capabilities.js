export const capabilityKeys = [
  "memory",
  "reminders",
  "webSearch",
  "webFetch",
  "browser",
  "documents",
];
export const capabilityTools = {
  webSearch: ["web_search"],
  webFetch: ["web_fetch"],
  browser: ["browser"],
  // `pdf` is not offered: OpenClaw needs a global agents.defaults.pdfModel (tracked
  // separately), so only image reading is granted.
  documents: ["view_image"],
};
export const webCapabilityKeys = ["webSearch", "webFetch", "browser", "documents"];
export const memoryTools = ["memory_search", "memory_get", "read", "write", "edit"];
// Writes reach the workspace only through the plugin's before_tool_call guard, which
// is verified live on these runtimes; elsewhere memory stays read-only.
export const guardedTools = ["write", "edit"];
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
 * session for SSH only, and only on hosts marked "Trusted incl. routines". `*__*`
 * stands for the agent's MCP tools (`<server>__<tool>`).
 */
export const routineTools = [
  "session_status",
  ...memoryTools,
  ...Object.values(capabilityTools).flat(),
  ...shellTools,
  "agentpier_ssh",
  "*__*",
];
export const personalEligible = (assistant) =>
  !assistant.archivedAt &&
  (!assistant.teamMemberId || assistant.lifetime === "permanent");
/**
 * A temporary member that runs with what its lead holds right now. The store
 * resolves `inherited` on every read (memberInheritance) and never stores it, so a
 * change to the lead reaches the member's next apply without copying anything.
 */
export const inheritsFromLead = (assistant) =>
  !!assistant.teamMemberId &&
  assistant.lifetime !== "permanent" &&
  !assistant.archivedAt &&
  !!assistant.inherited;
/**
 * What a temporary member of `lead` inherits: the lead's capabilities and skills, and
 * its shell level and SSH grants only while `shellSsh` (the lead's "Team members may
 * use shell and SSH", approved with the team and still on). Nothing without an
 * eligible lead.
 */
export function memberInheritance(lead, shellSsh = false) {
  const eligible = !!lead && personalEligible(lead);
  return {
    capabilities: eligible ? personalCapabilities(lead) : ownCapabilities({}),
    skills: eligible ? personalSkills(lead) : [],
    shell: eligible && shellSsh ? personalShell(lead) : "off",
    ssh: eligible && shellSsh,
  };
}
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
  // A temporary member reads its lead's memory but never writes it, and gets no
  // routines (standing jobs with tools that would outlive the team).
  const member = inheritsFromLead(assistant);
  return [
    "session_status",
    ...(teamsReady && !assistant.teamMemberId && !assistant.archivedAt
      ? delegationTools
      : []),
    ...(nativeReady && capabilities.memory
      ? memoryTools.filter(
          (tool) => (writeGuard && !member) || !guardedTools.includes(tool),
        )
      : []),
    ...(nativeReady && capabilities.reminders
      ? ["agentpier_reminder", ...(member ? [] : ["agentpier_routine"])]
      : []),
    // Temporary members use it only to request coding runs on the parent's grant.
    ...(nativeReady && !assistant.archivedAt ? ["agentpier_workspace"] : []),
    ...(nativeReady
      ? Object.entries(capabilityTools).flatMap(([key, tools]) =>
          // `available` withholds a tool whose browser or search provider is absent.
          capabilities[key] && available[key] !== false ? tools : [],
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
