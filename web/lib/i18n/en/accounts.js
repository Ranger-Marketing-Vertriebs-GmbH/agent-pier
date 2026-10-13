export const accountDialogCopy = {
  profileIsolationDescription:
    "A separate profile keeps sign-in and configuration isolated. You can then sign in directly in the terminal.",
  accountNamePlaceholder: "e.g. Personal or Work",
  toolLabel: "Tool",
  uninstalledToolSuffix: " · not installed",
  apiKeyLabel: "API key (optional)",
  savedKeyPlaceholder: "Saved · enter to replace",
  nativeKeyPlaceholder: "Alternative to interactive sign-in",
  nativeAuthenticationHelp:
    "For OpenCode, the API key is used for OpenAI. Set up other providers using “Sign in”. Leave the field empty to keep a saved key.",
  formNote: "Credentials are stored locally only.",
};
export const accountsPageCopy = {
  signedIn: "Signed in",
  defaultAccount: "Default account",
  setDefaultAccount: "Use as default",
  useDefaultAccount: (name) => `Use ${name} as default`,
  subtle: " Stored locally",
  pageHeadingTitle: "Your accounts",
  pageHeadingDescription: "One workspace. All your identities.",
  localProfileDescription: "Existing CLI profile on the AgentPier server",
  managedProfileWithKey: "Separate profile · API key saved",
  managedProfileDescription: "Separate profile",
  accountInfoHeading: "Everything stays on your computer.",
  accountInfoDescription:
    "Separate profiles have their own sign-in and configuration. Local profiles use the existing CLI sign-in on the AgentPier server. Choose a separate profile as the default account if you have not signed in there yet.",
};

export const accountsHubCopy = {
  intro:
    "Set up access here once. Which agent uses what is set in that agent's settings.",
  infoLabel: "Show note about accounts",
  groups: {
    models: "Model access",
    services: "Services for agents",
    mcpServers: "MCP servers",
    cli: "Native CLI accounts",
  },
  breadcrumb: (group) => `Accounts · ${group}`,
  selectHint: "Choose an entry on the left.",
  loading: "Loading …",
  sessionsOnly: "Sessions",
  sessionsCount: (count) => (count === 1 ? "1 session" : `${count} sessions`),
  pipelineProfile: "Pipeline profile",
  usedByNone: "Not in use yet.",
  agentKinds: { agent: "Agent", teamMember: "Temporary team member" },
  compatibleClis: "Compatible CLIs",
  restartsAgents: (count) =>
    count === 1 ? "Briefly restarts 1 agent." : `Briefly restarts ${count} agents.`,
  replaceKey: "Replace",
  connectionGroups: { connection: "Connection", test: "Test" },
  chatgptSub: (status) => `For agents · ${status}`,
  chatgptConnectSub: "Start a device-code sign-in",
  speechProvider: "Deepgram",
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  notReady: "Not configured",
  cliFindsSub: "Adopt entries from Claude Code, Codex and OpenCode",
  accountActions: "Sign-in and default",
};
