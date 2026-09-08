export const permissionModes = {
  claude: [
    "default",
    "manual",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
  ],
  codex: ["untrusted", "on-request", "never"],
  opencode: ["ask", "auto"],
};
export function blankProfile(account) {
  return {
    name: "",
    description: "",
    enabled: true,
    phaseKey: "custom",
    config: {
      accountId: account?.id || "",
      cliTool: account?.tool || "codex",
      models: { available: [""], default: "" },
      prompts: { role: "", kickoff: "", params: [] },
      permissions: { mode: permissionModes[account?.tool || "codex"][0] },
      run: { autonomous: false },
    },
  };
}
export function changeProfileAccount(profile, account) {
  if (!account) return profile;
  const modes = permissionModes[account.tool];
  return {
    ...profile,
    config: {
      ...profile.config,
      accountId: account.id,
      providerConnectionId: undefined,
      cliTool: account.tool,
      models: { available: [""], default: "" },
      permissions: {
        mode: modes.includes(profile.config.permissions.mode)
          ? profile.config.permissions.mode
          : modes[0],
      },
    },
  };
}
export function profileBody(profile) {
  const { name, description, enabled, phaseKey, config } = profile;
  return {
    name: name.trim(),
    description,
    enabled,
    phaseKey: phaseKey === "custom" ? null : phaseKey,
    config,
  };
}
