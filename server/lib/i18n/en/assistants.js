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
  sshApproval: "SSH command awaiting approval",
  sshAgent: (name) => `Agent: ${name}`,
  sshRequestedBy: (name) => `Requested by ${name}`,
  sshTarget: (name, endpoint) => `Host: ${name} (${endpoint})`,
  sshTimeout: (seconds) => `Time limit: ${seconds} s`,
  sshOpenToApprove:
    "The command is long or contains hidden characters. Review and allow it in AgentPier.",
  sshAllowOnce: "Allow once",
  sshDeny: "Deny",
  sshStates: {
    completed: (code) => `SSH command finished · exit code ${code}`,
    failed: "SSH command failed; review in AgentPier",
    declined: "SSH command denied",
    expired: "Approval expired; the command did not run",
    cancelled: "Approval cancelled; the access changed",
    unknown: "Outcome unknown; review in AgentPier",
  },
  sshTimedOut: "timed out",
  sshTruncated: "output truncated",
  execAllowlistPrograms: (programs) =>
    `Now always allowed for this agent, each with any arguments: ${programs}. Some programs can run other commands through their arguments, such as git hooks or aliases; "Always allow" covers that too. You can delete the entries in the agent settings.`,
  execAllowlistSkipped: (reason) =>
    `The command was allowed once: ${reason}. The agent will ask again next time.`,
  execAllowlistFailed:
    "The command was allowed once, but AgentPier could not add it to the allowlist. The agent will ask again next time.",

  heartbeatMemoryRequired:
    "Check-ins need memory. Switch on “Remember information” first, or switch check-ins off with it.",
  heartbeatPrefix: "Check-in:",
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
  teamReportShortened: "Report shortened – the whole report is in the member’s chat.",
  teamResultStates: { completed: "Completed", failed: "Failed", cancelled: "Cancelled" },
  teamApproval: (objective, count) =>
    `Team approval: ${objective}\n${count} members. Approve or decline?`,
  teamMemberShellSsh:
    "⚠ Members may use shell and SSH, at most with the lead's shell level and SSH grants. They also use the lead's web access, skills, MCP servers, memory (read-only) and reminders.",
  teamMemberNoShellSsh:
    "Members use the lead's web access, skills, MCP servers, memory (read-only) and reminders, but no shell and no SSH.",
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
  telegramReplyIncomplete: "Reply shortened – the rest could not be sent.",
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
  telegramBotInUse:
    "This Telegram bot is already in use: as your AgentPier bot or by another agent. Create a separate bot for each purpose.",
  skillUnavailable:
    "This skill is not available as a bundled OpenClaw skill, or a skill of the same name in the agent's folders would run in its place.",
  telegramSendersShell:
    "An agent with its own Telegram bot for other people must not have shell access. Turn shell off or disconnect the bot first.",
  telegramSendersStdio:
    "This agent has a stdio MCP server, which runs commands on this computer. Remove it before you connect a bot for other people.",
  telegramSendersSsh:
    "An agent with its own Telegram bot for other people must not have SSH accesses. Remove the SSH accesses or disconnect the bot first.",
  sshNotGranted: "This SSH access is not granted to the agent.",
  sshHostUnavailable:
    "This SSH access is unavailable: it was removed, or OpenSSH is missing.",
  sshRoutineNotTrusted:
    "In routines only SSH accesses marked “Trusted incl. routines” run.",
  sshOriginRefused: "SSH is not allowed in this turn.",
  sshBusy: "An SSH command is already running for this agent.",
  sshApprovalLimit: "Three SSH commands of this agent already wait for your approval.",
  sshRevoked: "The SSH access changed; the command was stopped.",
  memberModelFollowsLead:
    "A task-bound member uses its lead's model. Change the model there or keep the member as a permanent agent.",
  memberRequestNotPermanent: "Tasks can only be delegated to permanent members.",
  memberRequestOpenTask:
    "This member already has an open task. Wait for its result or cancel it first.",
  memberRequestNotFinished: "Only finished temporary members can be archived.",
  memberRequestRate:
    "The agent sent too many questions or tasks in a short time. Wait a moment.",
  memberRequestUnavailable: "This member has no chat yet and cannot answer.",
  memberRequestNoReply: (member) =>
    `${member} answered, but the agent's summary has no text. Check the chat.`,
  telegramSendersArchive:
    "Disconnect the agent's own Telegram bot before you archive it.",
  telegramSendersRestartRequired:
    "This Telegram change restarts the agents' Gateway; confirm the restart.",

  teamMcpServersUnavailable:
    "The MCP server list of this team cannot be read right now. Try again later.",
  teamMcpServerNotBound:
    "A proposed team member names an MCP server that is not bound to the lead agent.",
  attachmentTooLarge: "This file is larger than 10 MB.",
  attachmentUnsupported:
    "This file type is not supported. You can attach images (JPEG, PNG, WebP, GIF, HEIC), PDF and text files.",
  attachmentTooMany: "Too many attachments. A message can hold at most 5 files.",
  attachmentNotFound: "This attachment is no longer available. Add the file again.",
  attachmentStorageFull:
    "This agent's attachment folder is full. Ask the agent to delete older files in attachments/.",
  attachmentStorageUnsafe:
    "The attachment folder in this agent's workspace is unsafe. Check that attachments/ is a normal folder.",
  attachmentRateLimited: "Too many attachments in a short time. Wait a moment.",
  invalid: "Invalid agent input.",
  notFound: "Agent or conversation not found.",
  conflict: "The data has changed. Please reload.",
  capacity: "The team size exceeds this host's capacity. Choose a smaller value.",
  hostCapacity:
    "At least one agent team is larger than this value. Choose a larger capacity or reduce the team size.",
  unavailable: "The agent service is not ready. Check runtime settings.",
  agentLoading:
    "The agent service did not load the agent in time. Try again in a moment.",
  provider: "This model connection is not available for agents.",
  uncertain:
    "The outcome of this request is still unknown. Check the history before trying again.",
  queuedTooLong: "The queued message has no room for more text. Edit it first.",
  queuedSending: "The queued message is being sent right now.",
  queuedAttachment: "This attachment belongs to a queued message.",
  queuedFailed: "The queued message was not sent. Edit it first.",
  queuedExpired: "The queued message was older than a day and was not sent anymore.",
  queuedArchived: "This agent is archived and takes no more messages.",
  active: "A request is still running. Wait for its result or stop it first.",
  disabled: "Agents are turned off. Turn them on under Settings > Agents.",
  storageUnsafe:
    "The agent storage folder is unsafe. Check its owner and links in the data directory.",
  restartRequired:
    "Agents use this connection. Changing it restarts their Gateway; confirm the restart.",
  webToolsRestartRequired:
    "This web tool change restarts the agents' Gateway; confirm the restart.",
  advancedRestartRequired:
    "This setting takes effect only after the agent service restarts; confirm the restart.",
  advancedSettingUnavailable:
    "This setting is not available with the installed agent runtime.",
  shellConfirmationRequired:
    "With shell access the agent runs commands as your user account on this computer, including outside its workspace. Confirm the warning to turn access on.",
  shellFullConfirmationRequired:
    "With full shell access the agent runs every command without asking. Confirm this explicitly.",
  modelsRateLimited: "Too many model list refreshes. Please try again in a minute.",
  allowlistEntryNotFound:
    "This entry is no longer on the list of allowed commands. Please reload.",
};
