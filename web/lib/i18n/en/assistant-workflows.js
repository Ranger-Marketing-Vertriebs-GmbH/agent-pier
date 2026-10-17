export const assistantWorkflowCopy = {
  title: "Projects and coding tasks",
  hint: "Choose the projects and pipelines this agent may use. Project memory remains separate from personal notes.",
  projects: "Allowed projects",
  pipelines: "Allowed pipelines",
  projectsIntro:
    "Allowed projects can be used for project memory and coding tasks. Direct folder access additionally lets the agent read files in the project folder, or read and change them.",
  folderLegend: "Direct folder access",
  folderLevels: {
    none: "None",
    read: "Read",
    write: "Read and write",
  },
  folderHints: {
    none: "Only project memory and coding tasks.",
    read: "Lists, reads and searches files in the folder.",
    write:
      "Also creates and changes files. Every change is recorded with its path and size; .git stays locked.",
  },
  folderWarning:
    "The agent changes files directly, without an approval per change. Content it reads can steer it; use version control to review changes.",
  folderSummary: (count) =>
    count === 1 ? "1 with folder access" : `${count} with folder access`,
  noResources:
    "No registered entries yet. Configure projects and pipelines in AgentPier first.",
  memoryWrite: "Allow proposals to update project memory",
  autonomous: "Start selected coding pipelines without an additional approval",
  publish: "Allow selected pipelines to publish pull requests",
  policyHint:
    "Memory changes always require approval. Coding tasks require approval unless enabled above. Saving records the selected pipeline and account configuration; save again after changing a pipeline. Human pipeline gates remain in place.",
  removedProjects: (count) =>
    count === 1
      ? "1 allowed project no longer exists and was removed from this agent's access."
      : `${count} allowed projects no longer exist and were removed from this agent's access.`,
  actions: "Actions and coding tasks",
  noActions:
    "No actions yet. Ask this agent in chat to inspect project memory or propose a coding task.",
  coding: "Coding task",
  memory: "Project memory change",
  branch: "Base branch",
  revision: "Expected revision",
  runStatus: "Pipeline status",
  humanGate: "Review required step",
  openRun: "Open run and artifacts",
  approve: "Approve action",
  decline: "Decline action",
  cancel: "Stop coding task",
  review: "Mark outcome as checked",
  unknownHint:
    "The outcome is uncertain. Inspect the linked pipeline or project memory before issuing a new request. Marking it as checked closes this notice without retrying the action.",
  requestedBy: (name) => `Requested by team member ${name}`,
  memberApprovalHint:
    "Coding tasks from team members always need your approval, even with standing permission. They use this agent's project access.",
  pendingApprovals: "Waiting for your approval",
  teamRequests: "Coding requests from the team",
  diagnostics: {
    MEMORY_FORGOTTEN:
      "The text was removed because it was permanently forgotten from project memory.",
    GRANT_REVOKED: "Access or pipeline changed since the request. Nothing was started.",
    TEAM_STOPPED: "Withdrawn because the team was stopped.",
  },
  states: {
    awaiting_approval: "Awaiting approval",
    approved: "Approved",
    executing: "Starting",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    declined: "Declined",
    expired: "Approval expired",
    unknown: "Outcome unknown",
    reviewed: "Outcome checked",
  },
  chatNote: {
    started: (member) =>
      member ? `Coding run requested by ${member} started` : "Coding run started",
    completed: (member) =>
      member ? `Coding run requested by ${member} completed` : "Coding run completed",
    failed: (member) =>
      member ? `Coding run requested by ${member} failed` : "Coding run failed",
    cancelled: (member) =>
      member ? `Coding run requested by ${member} cancelled` : "Coding run cancelled",
  },
  runStates: {
    running: "Running",
    "awaiting-human": "Waiting for your decision",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  },
  nodeStates: {
    "awaiting-gate": "Waiting for approval",
    passed: "Passed",
    pending: "Pending",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    skipped: "Skipped",
    "awaiting-human": "Waiting for your decision",
  },
  providerReasons: {
    unsupportedProvider: "Provider not supported for agents",
    unsupportedProtocol: "Endpoint protocol not supported",
    credentialsRequired: "Credentials required",
    modelConfiguration: "Configure a model with at least 4,000 context tokens",
    unsupportedAuthentication:
      "This authentication header is not supported by the agent runtime",
  },
};
