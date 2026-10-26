/* global self */
// English notification texts; public/pwa-de.js has the same keys.
self.agentPierNotificationCopyEn = {
  kinds: {
    permission: {
      title: "AgentPier: Approval required",
      body: "A session is waiting for your decision.",
      name: "Approval required",
    },
    question: {
      title: "AgentPier: Question",
      body: "A session is waiting for your answer.",
      name: "Question",
    },
    "session-completed": {
      title: "AgentPier: Response ready",
      body: "Open AgentPier to see the latest progress.",
      name: "Response ready",
    },
    "session-waiting": {
      title: "AgentPier: Session waiting",
      body: "A session is waiting for you in the terminal.",
      name: "Waiting in the terminal",
    },
    "session-ended": {
      title: "AgentPier: Session ended",
      body: "Open AgentPier to see the status.",
      name: "Session ended",
    },
    "pipeline-gate": {
      title: "AgentPier: Pipeline waiting",
      body: "A pipeline is waiting for your decision.",
      name: "Pipeline waiting",
    },
    "pipeline-completed": {
      title: "AgentPier: Pipeline completed",
      body: "Open AgentPier to see the result.",
      name: "Pipeline completed",
    },
    "pipeline-failed": {
      title: "AgentPier: Pipeline failed",
      body: "Open AgentPier to see what failed.",
      name: "Pipeline failed",
    },
    "agent-approval": {
      title: "AgentPier: Approval required",
      body: "An agent is waiting for your decision.",
      name: "Approval required",
    },
    "agent-checkin": {
      title: "AgentPier: Agent check-in",
      body: "An agent has something for you. Open the agent's chat.",
      name: "Check-in",
    },
    "agent-routine": {
      title: "AgentPier: Routine or hook result",
      body: "A routine, reminder or hook has written in an agent's chat.",
      name: "Routine or hook result",
    },
    "agent-hook-throttled": {
      title: "AgentPier: Hook limit reached",
      body: "A hook received more events this hour than it may wake its agent for. Further events are only recorded.",
      name: "Hook limit reached",
    },
    "telegram-revocation": {
      title: "AgentPier: Telegram access still active",
      body: "A bot or person you removed could not be stopped. Restart the agent service.",
      name: "Telegram access still active",
    },
    "github-token": {
      title: "AgentPier: Check GitHub token",
      body: "A saved GitHub token is invalid, expired or expires soon.",
      name: "Check GitHub token",
    },
    "disk-space": {
      title: "AgentPier: Disk space is low",
      body: "Less than 10% is free on the drive that holds AgentPier's data.",
      name: "Disk space is low",
    },
    test: {
      title: "AgentPier: Test notification",
      body: "Notifications are reaching this device.",
      name: "Test notification",
    },
  },
  // What an agent asks to approve.
  subjects: {
    exec: "Shell command",
    ssh: "SSH command",
    coding: "Coding task",
    memory: "Memory entry",
    grant: "Member permission",
    hook: "Hook proposal",
    team: "Team proposal",
  },
  tools: {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
  },
  quote: (text) => `“${text}”`,
};
