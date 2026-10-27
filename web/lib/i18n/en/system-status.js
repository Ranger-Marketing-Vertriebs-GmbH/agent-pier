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
  host: {
    computer: "This computer",
    cores: (count) => (count === 1 ? "1 core" : `${count} cores`),
    memory: (size) => `${size} RAM`,
    platforms: { darwin: "macOS", linux: "Linux" },
  },
  live: "Live · every 5 s",
  tabsLabel: "System status sections",
  tabs: { load: "Load", processes: "Processes", storage: "Storage" },
  reclaimable: (size) => `${size} reclaimable`,
  load: (one, five, fifteen) => `Load average ${one} · ${five} · ${fifteen}`,
  historyHeading: "History",
  range: { label: "Time range", quarter: "15 min", hour: "1 h" },
  rangeName: { quarter: "15 minutes", hour: "hour" },
  historyAgo: (minutes) => `−${minutes} min`,
  historyNow: "now",
  historyTime: "Time",
  historyGapNote:
    "Hatched: nothing measured because no view was open. One sample a minute, every 5 s while the system status is open.",
  historyEmpty:
    "The history fills over the first hour after AgentPier starts: one sample a minute, every five seconds while this view is open.",
  historyCpu: "CPU",
  historyMemory: "RAM",
  historyAgentPier: "AgentPier CPU",
  historyLabel: (range, cpu, memory, agentPier) =>
    `CPU, RAM and AgentPier CPU over the last ${range}; now ${cpu}, ${memory} and ${agentPier}`,
  shareHeading: "AgentPier's share",
  shareLink: "Break down by process",
  shareCpu: "Computer CPU",
  shareMemory: "Computer RAM",
  shareOf: (part, whole) => `${part} of ${whole}`,
  shareOfUsed: (part, whole) => `${part} of ${whole} used`,
  shareAgentPier: "AgentPier",
  shareOther: "Other programs",
  processTotalCpu: "AgentPier total · CPU",
  processSort: "Sort",
  processSortName: "Name",
  processName: "Part",
  processActions: "Actions",
  processes: (count) => (count === 1 ? "1 process" : `${count} processes`),
  groupCore: "AgentPier core",
  groupSessions: (count) => `Sessions · ${count} running`,
  serverSub: "Web interface, API, tmux",
  gatewaySub: "OpenClaw · runs the agents",
  gatewayAgents: (count) => `OpenClaw · ${count === 1 ? "1 agent" : `${count} agents`}`,
  openSession: "Open",
  openSessionLabel: (name) => `Open ${name}`,
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
  dataUsed: "Used",
  dataReclaimable: "Of which reclaimable",
  dataMore: (count, size) => `${count} more · ${size}`,
  dataFewer: "Show fewer",
  driveHeading: "Drive with the AgentPier data",
  driveAgentPier: (size) => `AgentPier ${size}`,
  driveOther: (size) => `Other data ${size}`,
  driveFree: (size) => `Free ${size}`,
  driveNote: (threshold) => `The start page warns once less than ${threshold} is free.`,
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
    upTo: (size) => `Up to ${size} can be deleted`,
    measuredOnOpen: "Measured on open",
    footnote:
      "Nothing is deleted before you choose and confirm. What is in use right now stays.",
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
      caveat: "The way back to the old runtime goes away",
      facts: (count, oldest) =>
        count === 1
          ? `1 backup · from ${oldest}`
          : `${count} backups · oldest from ${oldest}`,
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
      caveat: "These sessions can no longer be resumed",
      facts: (count, days, profiles) =>
        `${count === 1 ? "1 transcript" : `${count} transcripts`} older than ${days} days · ${profiles === 1 ? "1 profile" : `${profiles} profiles`}`,
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
      caveat: "Installed again when needed",
      facts: (folders, agents) =>
        `${folders === 1 ? "1 folder" : `${folders} folders`} at ${agents === 1 ? "1 agent" : `${agents} agents`}`,
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
  cpuNote:
    "CPU shares are of the whole computer, all cores together. All agents run inside the agent gateway; stopped sessions use nothing.",
};
