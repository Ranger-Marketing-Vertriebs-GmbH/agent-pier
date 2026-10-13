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
export const writeGuardRuntimes = ["2026.9.8", "2026.9.9"];
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
export const personalEligible = (assistant) =>
  !assistant.archivedAt &&
  (!assistant.teamMemberId || assistant.lifetime === "permanent");
/** The effective shell level; ineligible or unset profiles have none. */
export function personalShell(assistant) {
  return personalEligible(assistant) && shellLevels.includes(assistant.shell)
    ? assistant.shell
    : "off";
}
export function personalCapabilities(assistant) {
  const eligible = personalEligible(assistant);
  return Object.fromEntries(
    capabilityKeys.map((key) => [
      key,
      eligible && assistant.capabilities?.[key] === true,
    ]),
  );
}
/** The capabilities at least one eligible profile has switched on. */
export function usedCapabilities(profiles = []) {
  const used = new Set();
  for (const profile of profiles)
    for (const [key, on] of Object.entries(personalCapabilities(profile)))
      if (on) used.add(key);
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
) {
  const capabilities = personalCapabilities(assistant);
  return [
    "session_status",
    ...(teamsReady && !assistant.teamMemberId && !assistant.archivedAt
      ? delegationTools
      : []),
    ...(nativeReady && capabilities.memory
      ? memoryTools.filter((tool) => writeGuard || !guardedTools.includes(tool))
      : []),
    ...(nativeReady && capabilities.reminders
      ? ["agentpier_reminder", "agentpier_routine"]
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
  ];
}
