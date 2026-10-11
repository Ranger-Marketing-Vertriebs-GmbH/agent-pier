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
  documents: ["pdf", "view_image"],
};
export const memoryTools = ["memory_search", "memory_get", "read", "write", "edit"];
// Writes reach the workspace only through the plugin's before_tool_call guard, which
// is verified live on these runtimes; elsewhere memory stays read-only.
export const guardedTools = ["write", "edit"];
export const writeGuardRuntimes = ["2026.9.8"];
export const delegationTools = [
  "agentpier_team_propose",
  "agentpier_team_status",
  "agentpier_team_stop",
];
export function personalCapabilities(assistant) {
  const eligible =
    !assistant.archivedAt &&
    (!assistant.teamMemberId || assistant.lifetime === "permanent");
  return Object.fromEntries(
    capabilityKeys.map((key) => [
      key,
      eligible && assistant.capabilities?.[key] === true,
    ]),
  );
}
export function profileTools(
  assistant,
  teamsReady,
  nativeReady,
  writeGuard = false,
  available = {},
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
          capabilities[key] && !(key === "browser" && available.browser === false)
            ? tools
            : [],
        )
      : []),
  ];
}
