export const systemStatusCopy = {
  title: "System status",
  rowLabel: "System status. Open details",
  disk: "Disk",
  cpu: "CPU",
  memory: "RAM",
  loading: "Reading system status …",
  unavailable: "System status unavailable",
  diskValue: (free, total) => `${free} free of ${total}`,
  usedValue: (used, total) => `${used} of ${total}`,
  cpuValue: (percent, cores) => `${percent} of ${cores} cores`,
  diskLowTitle: "Disk space is low",
  diskLow: (percent, threshold) =>
    `Only ${percent} is free on the drive that holds AgentPier's data (warning below ${threshold}). Delete old backups or unused data before the drive runs full.`,
  legacyTmuxTitle: (count) =>
    count === 1
      ? "1 session still runs on the old tmux server"
      : `${count} sessions still run on the old tmux server`,
  legacyTmux: (count) =>
    `Stop ${count === 1 ? "this session" : "these sessions"} when convenient; AgentPier then starts new sessions on the new server.`,
  legacyTmuxSessions: "Sessions on the old tmux server",
  hostHeading: "Computer",
  load: (one, five, fifteen) => `Load average ${one} · ${five} · ${fifteen}`,
  historyHeading: "Last hour",
  historyEmpty:
    "The history fills over the first hour after AgentPier starts: one sample a minute, every five seconds while this view is open.",
  historyCpu: "CPU",
  historyMemory: "RAM",
  historyAgentPier: "AgentPier CPU",
  historyLabel: (name, value) => `${name}: currently ${value}`,
  shareHeading: "AgentPier's share",
  shareTotal: (cpu, memory) => `${cpu} CPU · ${memory} RAM`,
  processHeading: "Processes",
  processName: "Part",
  processCount: "Processes",
  processCpu: "CPU",
  processMemory: "RAM",
  server: "AgentPier server",
  gateway: "Agent gateway",
  session: (name) => name || "Session",
  sessionTool: {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    shell: "Shell",
  },
  noSessions: "No session is running.",
  dataHeading: "Data directory",
  dataPending: "Measuring the data directory in the background …",
  dataRefreshing: "Updating sizes …",
  dataPartial: "The data directory is very large; sizes cover only part of it.",
  dataMeasured: (time) => `Measured ${time}`,
  dataTotal: (total) => `${total} in total`,
  areas: {
    profiles: "CLI profiles",
    clis: "CLI installations",
    tools: "Toolchains and MCP packages",
    runtimes: "Agent runtimes",
    backups: "Backups",
    chatAttachments: "Chat attachments",
    agentAttachments: "Agent attachments",
    agentShares: "Agent shares",
    agentWorkspaces: "Agent workspaces",
    secrets: "Secrets",
    logs: "Logs",
    other: "Other",
  },
  cleanup: {
    heading: "Free up space",
    open: "Clean up …",
    measuring: "Measuring what can be deleted …",
    atLeast: (size) => `at least ${size}`,
    freed: (size) => `Deleted. ${size} freed.`,
    none: "Nothing was deleted.",
    skipped: (count) =>
      count === 1
        ? "1 entry stayed: it changed meanwhile or is in use."
        : `${count} entries stayed: they changed meanwhile or are in use.`,
    snapshots: {
      title: "Update backups",
      sub: "The agents' state and runtime from before each runtime update",
      label: "Stored update backups",
      empty: "No update backup is stored.",
      versions: (from, to) => `Update ${from} → ${to}`,
      unknownVersions: "Update of the agent runtime",
      recovery: "Needed by an unfinished update",
      blocked:
        "An agent runtime update is running or needs its backups. Delete backups after it has finished.",
      deleteLabel: (date) => `Delete the update backup from ${date}`,
      confirmTitle: (date) => `Delete the update backup from ${date}?`,
      confirmBody: (size) => `This frees ${size}.`,
      confirmWarning: (version) =>
        version
          ? `The way back to the previous agent runtime (${version}) goes away: AgentPier can no longer restore the agents' state and runtime from before this update.`
          : "The way back to the previous agent runtime goes away: AgentPier can no longer restore the agents' state and runtime from before this update.",
      confirm: "Delete backup",
    },
    transcripts: {
      title: "Transcripts in CLI profiles",
      sub: "Conversations of ended Claude Code and Codex sessions",
      label: "Transcripts by CLI profile",
      age: "Last changed more than",
      days: (days) => `${days} days ago`,
      empty: "No Claude Code or Codex profile is set up in AgentPier.",
      summary: (count, size) =>
        count === 1 ? `1 transcript · ${size}` : `${count} transcripts · ${size}`,
      none: "Nothing that old",
      kept: (count) =>
        count === 1
          ? "1 more stays: AgentPier still lists its session"
          : `${count} more stay: AgentPier still lists their sessions`,
      deleteLabel: (name) => `Delete old transcripts of ${name}`,
      confirmTitle: (name, days) =>
        `Delete transcripts of "${name}" older than ${days} days?`,
      confirmBody: (count, size, days) =>
        count === 1
          ? `This deletes 1 transcript of an ended session, last changed more than ${days} days ago, and frees ${size}.`
          : `This deletes ${count} transcripts of ended sessions, last changed more than ${days} days ago, and frees ${size}.`,
      confirmWarning:
        "Those sessions can no longer be resumed and their history is gone. Transcripts of sessions AgentPier still lists, running or stopped, stay.",
      codexNote:
        "Codex also indexes its threads in its own databases. AgentPier leaves them unchanged, so Codex may still list those threads without their history.",
      confirm: "Delete transcripts",
    },
    dependencies: {
      title: "Installed agent dependencies",
      sub: "node_modules folders in the agents' workspaces",
      label: "Installed dependencies by agent",
      empty: "No agent workspace holds installed dependencies.",
      folders: (count) =>
        count === 1 ? "1 node_modules folder" : `${count} node_modules folders`,
      working: "The agent is working. Delete its dependencies when it has finished.",
      removedAgent: "Removed agent",
      deleteLabel: (name) => `Delete installed dependencies of ${name}`,
      confirmTitle: (name) => `Delete installed dependencies of "${name}"?`,
      confirmBody: (count, size) =>
        count === 1
          ? `This deletes 1 node_modules folder in the agent's workspace and frees ${size}.`
          : `This deletes ${count} node_modules folders in the agent's workspace and frees ${size}.`,
      confirmWarning:
        "The agent's own files stay. It installs the dependencies again when a project needs them (npm install), which takes time and a network connection.",
      confirm: "Delete dependencies",
    },
  },
  cpuNote: "CPU shares are of the whole computer, all cores together.",
};
