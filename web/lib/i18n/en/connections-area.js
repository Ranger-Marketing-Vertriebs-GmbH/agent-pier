// Zugänge (EN "Connections"): shared credentials, created once and granted where they
// are used. Category names keep the former Accounts and Settings › Access names.
export const connectionsAreaCopy = {
  title: "Connections",
  intro: "Create once, grant everywhere. Which agent uses what is shown with each entry.",
  categoriesLabel: "Categories",
  sections: {
    models: "Model access",
    services: "Services for agents",
    "mcp-servers": "MCP servers",
    ssh: "SSH/SFTP accesses",
    secrets: "Secrets",
    github: "GitHub connections",
  },
  breadcrumb: (section) => `Connections · ${section}`,
  flagged: (count) => (count === 1 ? "1 with a problem" : `${count} with a problem`),
  problemHint:
    "Highlighted numbers: entries with a problem (test failed, sign-in expired, update needed).",
  unknownCount: "Not known yet",
  loading: "Loading …",
  selectHint: "Choose an entry in the list.",
  backToList: (section) => `Back to ${section}`,
  views: {
    label: "Views",
    all: "All",
    problems: (count) => `With problems · ${count}`,
    unused: (count) => `Not used · ${count}`,
    today: "Used today",
  },
  lastUseCovers: (parts) => `“Last used” and “Used today” count ${parts} only.`,
  lastUseParts: {
    agentSsh: "agents' SSH commands",
    agentSftp: "agents' SFTP transfers",
    sessionSftp: "SFTP transfers of sessions",
  },
  lastUseUnknown: "When an entry was last used is not known right now.",
  searchLabel: "Search the list",
  searchSsh: "Name, host, user …",
  searchMcp: "Name, address, command …",
  filterAll: (label) => `${label}: all`,
  filters: {
    project: "Project",
    type: "Type",
    agent: "Used by",
    status: "Status",
    transport: "Transport",
    cli: "CLI",
    mcpAgent: "Agent",
  },
  groupBy: "Group",
  groupOptions: { project: "Project", source: "Source", status: "Status", none: "None" },
  sortBy: "Sort",
  sortOptions: { name: "Name", changed: "Last changed", used: "Last used" },
  columns: {
    name: "Name",
    type: "Type",
    kind: "Kind",
    usedBy: "Used by",
    status: "Status",
    last: "Last used",
    source: "Source",
  },
  selectVisible: "Select all visible",
  selectRow: (name) => `Select ${name}`,
  groupCount: (count) => String(count),
  groupProblems: (count) =>
    count === 1 ? "1 with a problem" : `${count} with a problem`,
  showMore: (count) => `Show ${count} more`,
  footer: (count, groups, problems) =>
    `${count} ${count === 1 ? "entry" : "entries"}${
      groups > 1 ? ` in ${groups} groups` : ""
    }${problems ? ` · ${problems} with a problem` : ""}`,
  keyboardHint: "↑↓ move · Space selects · Enter opens",
  noMatches: (query) => (query ? `No matches for “${query}”` : "No matching entries"),
  activeFilters: (count) =>
    count === 1 ? "1 filter active." : `${count} filters active.`,
  resetFilters: "Reset filters",
  selected: (count) => `${count} selected`,
  clearSelection: "Clear selection",
  bulkLabel: "Bulk actions",
  notUsed: "Not used",
  unknownUsage: "—",
  usedSummary: {
    agents: (count) => (count === 1 ? "1 agent" : `${count} agents`),
    hooks: (count) => (count === 1 ? "1 hook" : `${count} hooks`),
    sessions: (count) => (count === 1 ? "1 session" : `${count} sessions`),
  },
  never: "—",
  sshStatus: {
    ok: "OK",
    failed: "Test failed",
    hostKey: "Host key changed",
    untested: "Untested",
  },
  mcpStatus: {
    ok: "OK",
    loginRequired: "Sign-in expired",
    updateAvailable: "Update available",
    installFailed: "Installation failed",
    cliError: "CLI error",
  },
  mcpSources: {
    remote: "HTTP · internet",
    package: "Packages (npm, PyPI)",
    command: "Own commands",
  },
  mcpSourceShort: { oauth: "OAuth", headers: "Header", command: "Command" },
  details: "Details",
  fullView: "Full view",
  edit: "Edit",
  sshKind: "SSH access",
  sftpKind: "SFTP access",
  mcpKind: "MCP server",
  foundInClis: "Found in the CLIs",
  factLabels: {
    clis: "Coding CLIs",
  },
  checkStatus: "Check status",
  usedBy: {
    title: "Used by",
    titleCount: (count) => `Used by · ${count}`,
    agentKinds: { agent: "Agent", teamMember: "Temporary team member" },
    viaLead: (lead) => (lead ? `Shared by ${lead}` : "Shared by the lead"),
    hook: (name) => `Hook “${name}”`,
    hookOf: (agent) => `of ${agent}`,
    sessions: (count) =>
      count === 1 ? "1 coding session running" : `${count} coding sessions running`,
    sessionsHint: "Chosen at the start or in the session header",
    project: "Project",
    pipelinesNone: "Pipelines do not store connections.",
    none: "Not in use yet.",
    unknown: "Who uses this entry is not known right now.",
    agentsOff: "Agents are off; only sessions and projects are listed.",
    mode: (name) => `Mode for ${name}`,
    level: (name) => `GitHub access for ${name}`,
    revoke: "Revoke",
    revokeNamed: (name) => `Revoke ${name}`,
    revokeTitle: (agent, item) => `Revoke ${agent}'s access to ${item}?`,
    revokeBody: "The agent can no longer use this entry. You can grant it again later.",
    revokeNow: "Revoke now",
    raiseTitle: (agent) => `Let ${agent} run without asking?`,
    raiseConfirm: "Change mode",
    addAgent: "agent",
    noCandidates: "There is no agent to grant this to.",
    lockedHint: "Agents of users and temporary team members cannot get this access.",
    githubReplaceHint:
      "An agent has at most one GitHub access; adding it here replaces the one it has.",
    failed: (name, reason) => `${name}: ${reason}`,
    leadShareHint: "Shared by the lead: change it in the lead's settings.",
  },
  manage: {
    title: "Manage",
    activity: "Activity",
    activityHint: "Calls, approvals and changes of this entry",
    activityLink: "In the activity log",
    reassign: "Reassign project resources",
    reassignHint: "Move accesses and keys from one project to another",
    reassignButton: "Reassign",
    deleteAccess: "Delete access",
    deleteTitle: (name) => `Delete ${name}?`,
    deleteImpact: (agents, hooks) =>
      agents || hooks
        ? `${agents === 1 ? "1 agent" : `${agents} agents`} and ${
            hooks === 1 ? "1 hook" : `${hooks} hooks`
          } lose access`
        : "Nobody uses this access.",
    deleteImpactUnknown: "Who uses this access is not known right now.",
  },
  test: {
    title: "Last test",
    never: "Not tested yet.",
    ok: (time) => `Test succeeded · ${time}`,
    failed: (time) => `Test failed · ${time}`,
    hostKey: (time) => `Host key changed · ${time}`,
    rejected: "The connection works; the test command was rejected.",
    run: "Test connection",
    again: "Test again",
    running: "Testing …",
    hintKey: "Is the public key on the host?",
    affected: (names) => `Affected: ${names}`,
  },
  hostKey: {
    title: "Host key changed",
    body: "The host reports a different key than the pinned one. Connections stay blocked until you decide.",
    pinned: "Pinned",
    now: "Now",
    fetch: "Fetch current host key",
    fetching: "Fetching …",
    hint: "Only accept it if you know why it changed (for example a reinstall).",
    accept: "Accept new key",
    keepBlocked: "Keep blocked",
    acceptTitle: (name) => `Accept the new host key of ${name}?`,
    acceptBody:
      "AgentPier then trusts the new key for every agent, hook and session that uses this access.",
    acceptNow: "Accept now",
    accepted: "The new host key is pinned.",
  },
  sshForm: { unsaved: "Changes apply to everyone who uses this access." },
  bulk: {
    grant: "Grant agent …",
    test: "Test",
    assignProject: "Assign project …",
    revoke: "Revoke …",
    delete: "Delete",
    bindCli: "Bind to CLI …",
    checkUpdates: "Check updates",
    remove: "Remove",
    grantTitle: (count) =>
      count === 1 ? "Grant 1 access to agents" : `Grant ${count} accesses to agents`,
    grantMcpTitle: (count) =>
      count === 1
        ? "Grant 1 MCP server to agents"
        : `Grant ${count} MCP servers to agents`,
    agents: "Agents",
    mode: "Mode",
    grantButton: (count) =>
      count === 1 ? "Grant to 1 agent" : `Grant to ${count} agents`,
    revokeTitle: (count) =>
      count === 1
        ? "Revoke 1 access from agents"
        : `Revoke ${count} accesses from agents`,
    revokeBody: "The chosen agents lose these accesses. Hooks keep their own choice.",
    revokeButton: (count) =>
      count === 1 ? "Revoke from 1 agent" : `Revoke from ${count} agents`,
    noAgents: "No agent uses the selected accesses.",
    testTitle: (count) =>
      count === 1 ? "Testing 1 access" : `Testing ${count} accesses`,
    progress: (done, total) => `${done} of ${total}`,
    deleteTitle: (count) =>
      count === 1 ? "Delete 1 SSH/SFTP access?" : `Delete ${count} SSH/SFTP accesses?`,
    deleteBody:
      "Their keys stay. Agents, hooks and sessions that use them lose access; this cannot be undone.",
    affectedAgents: "Agents",
    affectedHooks: "Hooks",
    affectedSessions: "Sessions",
    affectedUnknown: "Not known right now",
    nobody: "Nobody",
    deleteNow: "Delete now",
    removeTitle: (count) =>
      count === 1 ? "Remove 1 MCP server?" : `Remove ${count} MCP servers?`,
    removeBody:
      "The servers leave every coding CLI and agent that uses them. Packages are uninstalled.",
    removeNow: "Remove now",
    bindTitle: (count) =>
      count === 1
        ? "Bind 1 MCP server to coding CLIs"
        : `Bind ${count} MCP servers to coding CLIs`,
    bindBody: "The chosen CLIs are added; CLIs a server already uses stay.",
    bindButton: "Bind",
    unsupported: (cli) => `${cli} does not support this server.`,
    consent: "I allow local commands to run for the chosen targets.",
    projectTitle: "Assign project",
    projectBody:
      "An access moves only together with every access and key of its project: AgentPier cannot move a single access, because its key belongs to the project.",
    projectMixed:
      "The selected accesses belong to different projects. Select accesses of one project to move that project's resources.",
    projectGlobal:
      "Global accesses cannot be moved to a project. Create the access again in the project instead.",
    projectMove: (name) => `Move every access and key of ${name}`,
    resultsTitle: "Results",
    resultOk: "Done",
    resultFailed: (reason) => `Failed: ${reason}`,
    summary: (ok, failed) =>
      failed ? `${ok} done, ${failed} failed` : ok === 1 ? "1 done" : `${ok} done`,
    close: "Close",
    upToDate: "Up to date",
    updateTo: (version) => `Update available: ${version}`,
    noPackage: "Not a package: nothing to check",
    gone: "The entry no longer exists.",
  },
  empty: {
    ssh: {
      title: "No SSH or SFTP accesses yet",
      body: "Accesses with a pinned host key that you can grant to agents, hooks and sessions.",
      primary: "Add access",
      secondary: "Add SSH key",
    },
    keys: {
      title: "No SSH keys yet",
      body: "Generate or import a key; accesses then sign in with it.",
      primary: "Add SSH key",
    },
    "mcp-servers": {
      title: "No MCP servers yet",
      body: "Add a server once and choose which coding CLIs and agents use it.",
      primary: "Add MCP server",
      secondary: "Found in the CLIs",
    },
    secrets: {
      title: "No secrets yet",
      body: "Tokens and addresses that agents and coding CLIs receive as environment variables.",
      primary: "New secret",
    },
    github: {
      title: "No GitHub connections yet",
      body: "Token profiles for clones, pull requests and agents with GitHub access.",
      primary: "Add access",
    },
  },
  githubUsedBy: (count) => (count === 1 ? "Used by 1" : `Used by ${count}`),
  githubDetails: (name) => `Details of ${name}`,
  githubLevels: { read: "Read", write: "Read and write" },
};
