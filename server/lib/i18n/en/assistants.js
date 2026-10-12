export const assistants = {
  actionApproval: "Action awaiting approval",
  actionHumanReview:
    "Your decision is required in the coding pipeline. Open the run in AgentPier.",
  actionRequestedByMember: (name) => `Requested by team member ${name}`,
  actionApprove: "Approve action",
  actionDecline: "Decline",
  actionStates: {
    approved: "Action approved",
    running: "Coding task running",
    completed: "Task completed",
    failed: "Action failed; review in AgentPier",
    cancelled: "Task cancelled",
    declined: "Action declined",
    expired: "Approval expired",
    unknown: "Outcome unknown; review in AgentPier",
    reviewed: "Outcome checked; action will not be retried",
  },

  execApproval: "Shell command awaiting approval",
  execAgent: (name) => `Agent: ${name}`,
  execCwd: "Folder:",
  execAllowOnce: "Allow once",
  execAllowAlways: "Always allow",
  execDeny: "Deny",
  execAllowAlwaysPrograms: (programs) =>
    `"Always allow" lets this agent run these without asking from now on, each with any arguments: ${programs}. Some programs can run other commands through their arguments, such as git hooks or aliases; "Always allow" covers that too. You can delete the entries in the agent settings.`,
  execWritablePrograms: (programs) =>
    `In folders you can write to: ${programs}. If one of them is changed or replaced, the agent runs the new version without asking. OpenClaw always denies commands with redirections (> or <) for such programs.`,
  execAllowAlwaysOnce: (reason) =>
    `"Always allow" allows this command only once: ${reason}. The agent will ask again next time.`,
  execOnceReasons: {
    interpreter: (program) => `${program} is an interpreter, shell or launcher`,
    inline: (program) => `${program} runs an inline script`,
    unresolved: (program) => `AgentPier cannot tie ${program} to a fixed program path`,
  },
  execOnceCommandReasons: {
    inline: "the command runs an inline script",
    unresolved: "AgentPier cannot tie the command to a fixed program",
    complex:
      "the command uses shell syntax AgentPier cannot tie to fixed programs, such as variables, environment assignments, command substitution, subshells, control structures or background jobs",
  },
  execDecided: {
    "allow-once": "Command allowed once",
    "allow-always": "Command always allowed",
    deny: "Command denied",
  },
  execStates: {
    declined: "Command denied",
    expired: "Approval expired; the command did not run",
    cancelled: "Approval cancelled; the command did not run",
    failed: "Approval failed; review in AgentPier",
    unknown: "Outcome unknown; review in AgentPier",
  },
  execAllowlistPrograms: (programs) =>
    `Now always allowed for this agent, each with any arguments: ${programs}. Some programs can run other commands through their arguments, such as git hooks or aliases; "Always allow" covers that too. You can delete the entries in the agent settings.`,
  execAllowlistSkipped: (reason) =>
    `The command was allowed once: ${reason}. The agent will ask again next time.`,
  execAllowlistFailed:
    "The command was allowed once, but AgentPier could not add it to the allowlist. The agent will ask again next time.",

  heartbeatChannelRequired:
    "Check-ins need a paired Telegram chat. Connect a Telegram chat to this agent first.",
  reminderChannelRequired: "Connect a Telegram chat to this agent first.",
  reminderTimezoneRequired:
    "Give the reminder time with a time zone offset, for example 2026-10-09T09:00:00+02:00.",
  routineReviewRequired:
    "It is unclear whether this routine was created. Review it in the agent settings before trying again.",
  reminderReviewRequired:
    "It is unclear whether this reminder was created. Review it in the agent settings before trying again.",
  reminderFailed: "A reminder could not run. Check its history in Agent Settings.",
  teamResultNoText: (objective) =>
    `Team results for ${objective}. No text is available for the completed synthesis. Review the individual reports.`,
  teamReportUnavailable:
    "No textual report is available. Open the member chat for further details.",
  teamResultStates: { completed: "Completed", failed: "Failed", cancelled: "Cancelled" },
  teamApproval: (objective, count) =>
    `Team approval: ${objective}\n${count} members. Approve or decline?`,
  teamMcpServers: (names) => `MCP servers: ${names}`,
  teamMcpStdio: (name) => `${name} (stdio, local command)`,
  teamMcpUnavailable:
    "MCP servers: the list cannot be read right now. Approve the team in AgentPier once it can be read.",
  teamApprove: "Approve team",
  teamDecline: "Decline team",
  teamApproved:
    "Team approved. Tasks are being scheduled; I will let you know when the team is working.",
  teamDeclined: "Team declined. No agents will be started for this proposal.",
  teamDecisionStale: "This proposal has already been decided or is no longer valid.",
  teamDecisionFailed: "The decision could not be saved. Try again in AgentPier.",
  telegramReplyUnavailable: "The answer has no text. Open AgentPier to view it.",
  telegramInputNeedsReview: "A message needs your attention in AgentPier.",
  telegramPrivateBot:
    "This bot is private and only answers the person it is paired with.",
  telegramMediaUnsupported:
    "This message type is not supported yet. Send text or a voice message.",
  telegramMediaCaptionUnsupported:
    "This message type is not supported yet, and its caption was not processed. Send text or a voice message.",
  telegramVoiceTooLong: (minutes) =>
    `Voice messages can be at most ${minutes} min long. Send a shorter one or type your message.`,
  telegramOpenInAgentPier: "Open in AgentPier",
  telegramQueueFull:
    "The queue is full. This message was not accepted; please try again later.",
  teamStartedBecause: (quote) => `Started because you wrote: “${quote}”`,
  teamStarted: (objective, count, total) =>
    `The team is working on: ${objective}\n${count} of ${total} agents are currently working. I will follow up with the results.`,
  teamResultFailed: (objective) =>
    `Team results for ${objective}. Synthesis failed or was cancelled. Review the individual reports.`,

  channelUnavailable: "The channel service is currently unavailable. Please try again.",
  channelWebhook:
    "This Telegram bot already uses a webhook. Disconnect its other integration first.",
  channelPolling: "Another service is using this Telegram bot. Stop it before resuming.",
  channelToken: "The Telegram bot token is invalid.",

  teamMcpServersUnavailable:
    "The MCP server list of this team cannot be read right now. Try again later.",
  teamMcpServerNotBound:
    "A proposed team member names an MCP server that is not bound to the lead agent.",
  invalid: "Invalid agent input.",
  notFound: "Agent or conversation not found.",
  conflict: "The data has changed. Please reload.",
  unavailable: "The agent service is not ready. Check runtime settings.",
  provider: "This model connection is not available for agents.",
  uncertain:
    "The outcome of this request is still unknown. Check the history before trying again.",
  active: "A request is still running. Wait for its result or stop it first.",
  disabled: "Agents are turned off. Turn them on under Settings > Agents.",
  storageUnsafe:
    "The agent storage folder is unsafe. Check its owner and links in the data directory.",
  restartRequired:
    "Agents use this connection. Changing it restarts their Gateway; confirm the restart.",
  webToolsRestartRequired:
    "This web tool change restarts the agents' Gateway; confirm the restart.",
  shellConfirmationRequired:
    "With shell access the agent runs commands as your user account on this computer, including outside its workspace. Confirm the warning to turn access on.",
  shellFullConfirmationRequired:
    "With full shell access the agent runs every command without asking. Confirm this explicitly.",
  allowlistEntryNotFound:
    "This entry is no longer on the list of allowed commands. Please reload.",
};
