export const assistantSettingsCopy = {
  tabsLabel: "Agent settings",
  tabs: {
    overview: "Overview",
    identity: "Identity",
    capabilities: "Capabilities",
    access: "Access",
    team: "Team",
    automation: "Automation",
    channels: "Channels",
  },
  backToAgents: "Back to agents",
  overviewGroups: {
    glance: "At a glance",
    glanceHint: "What this agent can do and use. Each row opens its tab.",
    manage: "Manage",
  },
  glance: {
    viaTemplate: "from a template",
    followsLead: "follows the lead's model",
    none: "Nothing switched on",
    memory: "Memory",
    web: "Web",
    browser: "Browser",
    documents: "Images",
    pdfs: "PDFs",
    reminders: "Reminders",
    shell: (level) => `Shell: ${level}`,
    skills: (count) => (count === 1 ? "1 skill" : `${count} skills`),
    projects: (count) => (count === 1 ? "1 project" : `${count} projects`),
    mcp: (count) => `${count} MCP`,
    ssh: (count) => `${count} SSH/SFTP`,
    github: (level) => `GitHub ${level}`,
    secrets: (count) => (count === 1 ? "1 secret" : `${count} secrets`),
    teams: (count) => (count === 1 ? "1 active team" : `${count} active teams`),
    checkIns: "Checks in on its own",
    noCheckIns: "Does not check in on its own",
    remindersOff: "Reminders and routines off",
    telegramConnected: "Telegram connected",
    telegramOff: "Telegram not connected",
  },
  duplicate: "Duplicate",
  duplicateHint: "New agent with these capabilities and access",
  archiveHint: "Chat and memory stay; can be restored",
  access: {
    intro:
      "Everything the agent may use. Create it under Connections and add it right in its group: type, tick, add.",
    projects: "Projects",
    ssh: "SSH/SFTP",
    mcp: "MCP servers",
    pipelines: "Pipelines",
    github: "GitHub",
    secrets: "Secrets",
    count: (label, count) => `${label} · ${count}`,
    countOf: (label, count, total) => `${label} · ${count} of ${total}`,
    sameAsProject: "The same setting as in the project: Projects › Agents",
    more: (count) => `${count} more`,
    showAll: "Show all",
    revoke: "Revoke",
    revokeLabel: (name) => `Revoke ${name}`,
    modeLabel: (name) => `Mode for ${name}`,
    folderLabel: (name) => `Folder access for ${name}`,
    sessionsLabel: (name) => `Coding sessions for ${name}`,
    sessions: "Coding sessions",
    projectType: "project",
    sshType: "SSH/SFTP access",
    mcpType: "MCP server",
    pipelineType: "pipeline",
    secretType: "secret",
    mcpSetup: "Set up MCP servers",
    mcpOpen: "Open",
    mcpOpenLabel: (name) => `Open ${name} in Connections`,
    empty: "Nothing granted yet",
    whoUses: "Who uses this agent",
  },
  sharedWithMembers: "Shared with members",
  sharedWithMembersHint:
    "What this agent shares of its own access with its members. It counts only while the agent holds it itself.",
  sharedWithMembersEmpty: "This agent shares nothing with its members.",
  sharedTo: (member) => `to ${member}`,
  allTeams: "All teams of all agents",
  allTeamsPath: "Agents › Teams",
  notificationsGroup: "Notifications",
  notificationsRow: "Push on your devices",
  notificationsPath: "Settings › App and notifications",
  createAgent: "Create agent",
  backTo: (tab) => `Back to ${tab}`,
  searchProvider: (name) => `Search provider · ${name}`,
  speechProvider: "Speech recognition · Deepgram",
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  manageMcpServers: "Manage MCP servers",
  pendingApprovals: (count) => `Waiting for your approval · ${count}`,
  numberRange: (min, max) => `Enter a whole number from ${min} to ${max}.`,
  teamGroup: "Team",
  connectionGroup: "Connection",
  connectionPage: "Connection",
  activityAttention: (count) =>
    count === 1 ? "1 needs your decision" : `${count} need your decision`,
  allDelivered: "All delivered",
  noActivity: "No activity yet",
  replaceToken: "Replace bot token",
  replaceTokenHint: "Only a new token for the same bot is accepted.",
  addReminder: "+ Create reminder",
  addRoutine: "+ Routine",
  remindersNeedCapability:
    "Reminders and routines are off for this agent. Switch on “Allow reminders and routines” under Capabilities.",
  heartbeatNeedsMemory:
    "Needs memory: switch on “Remember information” under Capabilities.",
  mainChatRestart: {
    group: "Danger zone",
    row: "Restart main chat",
    rowHint: "Starts every main chat of this agent over. Memory stays.",
    title: (name) => `Restart the main chat of “${name}”?`,
    body: "The agent loses its conversations so far, and all its running work stops at once.",
    confirm: "Restart main chats and stop work",
    goes: (people) =>
      people === 1
        ? "Goes: the conversation history and summaries of 1 main chat."
        : `Goes: the conversation history and summaries of ${people} main chats.`,
    stays:
      "Stays: memory, files, settings, routines and reminders. Routines and reminders are not checked.",
    notSaved: "Nothing is saved beforehand.",
    temporary: (count) =>
      count === 1 ? "1 temporary member ends." : `${count} temporary members end.`,
    permanent: (count) =>
      count === 1
        ? "1 permanent member starts fresh."
        : `${count} permanent members start fresh.`,
    workIntro: "Work that will be cancelled:",
    work: {
      turns: (count) => (count === 1 ? "1 running turn" : `${count} running turns`),
      teams: (count) =>
        count === 1
          ? "1 team proposal awaiting approval"
          : `${count} team proposals awaiting approval`,
      members: (count) =>
        count === 1 ? "1 temporary member at work" : `${count} temporary members at work`,
      requests: (count) =>
        count === 1
          ? "1 open request to a permanent member"
          : `${count} open requests to permanent members`,
      coding: (count) =>
        count === 1
          ? "1 coding session or workflow"
          : `${count} coding sessions and workflows`,
      goals: (count) =>
        count === 1 ? "1 active work goal" : `${count} active work goals`,
      approvals: (count) =>
        count === 1 ? "1 pending approval" : `${count} pending approvals`,
    },
    archived: "The old main chats stay readable under archived chats.",
    acknowledge: "I understand this cannot be undone",
    loading: "Checking what the restart affects …",
    loadFailed: "Could not load what the restart affects.",
    done: "Main chats restarted. The previous ones are under archived chats.",
  },
};
