export const assistantCopy = {
  updates: {
    title: "OpenClaw updates",
    description:
      "Stage the version qualified by AgentPier, then activate it with a private backup and recovery.",
    current: "Current version",
    target: "Target version",
    stage: "Stage update",
    activate: "Activate update",
    recover: "Continue recovery",
    phase: "Update status",
    blocked:
      "Active or unresolved work blocks activation. Review chats, tasks and deliveries.",
    blockers: {
      ASSISTANT_WORK: "An agent chat is still working or awaits your review.",
      TEAM_WORK: "A team task is still running.",
      CHANNEL_WORK:
        "A Telegram message or notice is still open. Review it in the agent's Channels › Telegram activity.",
      ACCOUNT_LOGIN: "A model account sign-in is still in progress.",
      WORKFLOW_WORK: "An agent action is approved or still running.",
      SCHEDULED_WORK: "A reminder or routine is running right now.",
    },
    unknownBlocker: "Other open work.",
    openWork: "Open work",
    itemKinds: {
      chat_turn: "Chat turn",
      chat_summary: "Chat summary",
      team_task: "Team task",
      channel_input: "Telegram input",
      channel_notice: "Telegram notice",
      workflow: "Agent action",
      routine_run: "Routine run",
      login: "Model account sign-in",
    },
    itemLabel: (kind, agent) => (agent ? `${kind} · ${agent}` : kind),
    since: (time) => `Since ${time}`,
    resolutions: {
      stop: "The running turn is stopped.",
      review: "Marked as reviewed. Nothing is sent again.",
      cancel: "Cancelled and recorded as cancelled.",
      close: "Closed without sending. Nothing is sent again.",
      wait: "Cannot be stopped from AgentPier. The update waits up to two minutes for it to end; nothing new starts.",
      none: "Not cancelled for the update. Finish or cancel the sign-in under Connections › Model access first.",
    },
    pause: "Pause agents and update",
    pauseHint:
      "Pauses the agents, resolves open work as listed in the confirmation and then activates the update.",
    pauseLoginHint:
      "A model account sign-in is in progress. Finish or cancel it under Connections › Model access, then pause the agents and update.",
    pauseTitle: (version) => `Pause agents and update to ${version}?`,
    pauseBody:
      "No agent starts new work until the update has finished. AgentPier then resolves the open work below as listed, records each step in the activity log, creates a backup, activates the new version and checks it. If the check fails, the previous version is restored.",
    pauseNoResume: "Stopped turns and cancelled tasks do not resume after the update.",
    pauseNothing: "No work is running or open right now.",
    pauseLoading: "Checking open work …",
    pauseConfirm: "Pause and update",
    phases: {
      idle: "Ready",
      staging: "Staging",
      staged: "Staged",
      draining: "Draining work",
      snapshotting: "Creating backup",
      activating: "Activating",
      migrating: "Migrating data",
      validating: "Validating",
      committed: "Committed; resuming operation",
      complete: "Update complete",
      rolling_back: "Restoring previous version",
      rollback_committed: "Restored; resuming operation",
      rolled_back: "Previous version restored",
      recovery_required: "Recovery required",
    },
    cause: (detail) => `Cause: ${detail}`,
    failedAt: (step, detail) => `Failed step: ${step}${detail ? ` (${detail})` : ""}`,
    steps: {
      stop: "Stopping",
      snapshot: "Backup",
      migrate: "Data migration",
      start: "Start",
      validate: "Check",
      verify: "Backup check",
    },
    diagnostics: {
      UPDATE_STAGE_FAILED: "Staging failed. The active version is preserved.",
      UPDATE_STAGE_INTERRUPTED: "Staging was interrupted. Stage again.",
      UPDATE_BLOCKED: "Active or unresolved work blocks the update.",
      UPDATE_CONFIG_BUSY:
        "The runtime is not accepting configuration changes right now. Try again in a minute.",
      UPDATE_PREPARE_FAILED:
        "The runtime could not be prepared for the update. The active version is kept; try again shortly.",
      UPDATE_ROLLED_BACK: "Activation failed; the previous version was restored.",
      UPDATE_MIGRATION_FAILED:
        "Migrating the data to the new version failed; the previous version was restored.",
      UPDATE_RECOVERY_REQUIRED: "Recovery is required. The service remains stopped.",
      UPDATE_RESUME_REQUIRED:
        "State was committed. Resume without rolling back later work.",
      UPDATE_ROLLED_BACK_LOGIN_REQUIRED:
        "Activation failed; the previous version was restored. Credentials revoked since the backup were not restored. Sign in again where needed.",
      INSUFFICIENT_SPACE:
        "Not enough free disk space for the backup. Free up space, then activate again.",
      RUNTIME_BUSY: "Another AgentPier process is installing OpenClaw. Try again later.",
      SNAPSHOT_FAILED:
        "The backup could not include the file shown below. The previous version remains active.",
    },
    snapshotProgress: (copied, total) => `Creating backup: ${copied} of ${total}`,
    upToDate: "The qualified version is already active.",
    affected: (count, members = 0) =>
      `${count} ${count === 1 ? "agent" : "agents"} affected${members ? ` (+${members} team ${members === 1 ? "member" : "members"})` : ""}`,
  },

  personal: {
    memoryGroup: "Memory & reminders",
    webGroup: "Web & documents",
    enableWebSearch: "Search the web",
    enableWebFetch: "Read web pages",
    enableBrowser: "Use a browser",
    enableDocuments: "Read images",
    enableCreateImages: "Create images",
    memoryDescription: "Keeps its own notes between conversations.",
    remindersDescription: "Sends reminders and runs schedules through Telegram.",
    webSearchDescription:
      "Looks things up with the web search provider set in Connections.",
    webFetchDescription: "Opens a web address and reads the page text.",
    browserDescription:
      "Drives a persistent browser profile of its own for pages that need clicking or signing in.",
    documentsDescription:
      "Looks at images in its workspace. Needs a model that accepts images.",
    createImagesDescription:
      "Creates and edits images with your ChatGPT account (gpt-image-2) and hands them to you in the chat.",
    imagesUnavailable:
      "Connect a ChatGPT account under Connections › Model access to create images.",
    imagesRuntimeMove: (runtime) =>
      `Agents on ${runtime} create images with a ChatGPT login AgentPier holds. Move your ChatGPT login to AgentPier under Connections › Model access.`,
    browserUnavailable:
      "No supported browser found on this computer. Install Chrome, Brave, Edge or Chromium to use this.",
    searchUnavailable:
      "Web search is not set up. Choose a provider and add its key in Connections.",
    availableAfterSaving: "Available after saving the agent",
    webHint:
      "Web pages can contain instructions meant to mislead the agent. Switch these on only for agents whose other tools you would trust with that.",
    restartTitle: "Restart the agent service?",
    restartBody:
      "This change restarts the agents' service briefly. Running work is not interrupted: if an agent is busy, the save is refused and nothing changes.",
    restartAffected: (names, members = 0) =>
      `Briefly unavailable: ${names || "no agents"}${members ? ` (+${members} team ${members === 1 ? "member" : "members"})` : ""}`,
    restartConfirm: "Save and restart",
    restartCancel: "Cancel",
    capabilities: "Personal assistance",
    enableMemory: "Remember information",
    enableReminders: "Allow reminders and routines",
    capabilityHint:
      "Each agent has its own notes. Turning reminders off pauses its schedules.",
    memory: "Memory",
    memoryHint:
      "Manage this agent’s lasting notes and preferences, or search all its saved notes.",
    noteType: "Note type",
    facts: "Long-term notes",
    preferences: "Preferences",
    agentNotes: "Notes written by the agent",
    agentNotesHint:
      "The agent writes these notes itself. They are shown read-only here; ask the agent to change them.",
    editableNotesHint:
      "The agent also writes and reads this note. Your changes apply to its next reading.",
    deleteNote: "Delete note",
    deleteNoteTitle: (name) => `Delete note "${name}"?`,
    deleteNoteBody:
      "The note is removed from the agent's memory. This does not delete messages from chat history.",
    notes: "Saved notes",
    saveNotes: "Save notes",
    clearNotes: "Clear draft",
    reload: "Reload notes",
    clearHint:
      "Save an empty note to clear it. This does not delete messages from chat history.",
    searchMemory: "Search memory",
    search: "Search",
    noResults: "No matching notes found.",
    openNote: "Open note",
    openNoteNamed: (name) => `Open note ${name}`,
    reminders: "Reminders",
    remindersHint:
      "Receive one-time or daily reminders in this agent’s chat with a push notification. You can also ask for reminders in chat.",
    reminderName: "Reminder name",
    reminderText: "Reminder text",
    repeat: "Repeat",
    once: "Once",
    daily: "Daily",
    when: "Date and time",
    time: "Time",
    timezone: "Timezone",
    localTime: (zone) => `Local time (${zone})`,
    createReminder: "Create reminder",
    noReminders: "No reminders yet.",
    unknownReminder: "Reminder awaiting reconciliation",
    pauseReminder: "Pause reminder",
    resumeReminder: "Resume reminder",
    removeReminder: "Remove reminder",
    removeReminderTitle: (name) => `Remove reminder “${name}”?`,
    removeReminderBody:
      "It is not sent again. Reminders it already sent stay in the chat.",
    reviewReminder: "Mark as reviewed",
    reviewReminderHint:
      "It is unclear whether this reminder was created. It will not be created again automatically.",
    history: "Run history",
    noRuns: "No runs yet.",
    nextRun: (time) => `Next: ${time}`,
    telegramDelivery: (state) => `Telegram: ${state}`,
    invalidTime: "Choose a valid future date and time.",
    states: {
      active: "Active",
      paused: "Paused",
      completed: "Completed",
      unknown: "Outcome unknown — review before retrying",
      failed: "Failed",
      removed: "Removed",
      succeeded: "Completed",
      ok: "Completed",
      error: "Failed",
      skipped: "Skipped",
    },
  },
  team: {
    modelChanged: "Model: changed since taken over from the lead",
    modelOriginal: "Model: as taken over from the lead",
    followsLeadModel: "Runs on the lead's current model and changes with it.",
    followLeadModelChoice: "Follow the lead's model",
    instructionsChanged: "Instructions: changed since creation",
    instructionsOriginal: "Instructions: as created",
    setupUnknown:
      "Setup may already have taken effect. Review the state before acknowledging uncertainty. The service restarts; this member finishes as failed and is not replaced.",
    title: "Teams",
    settings: "Team settings",
    memberSettings: "Team member",
    allowOnce: "Allow a team for this message",
    startedBecause: (quote) => `Started because you wrote: “${quote}”`,
    approvalHint:
      "This team is waiting for your approval. Members will have their own chats.",
    approve: "Approve team",
    decline: "Decline team",
    stopTeam: "Stop team",
    stopMember: "Stop member",
    allowedChip: "Team allowed",
    archive: "Archive",
    restore: "Restore",
    autonomous: "Allow teams without asking each time",
    // How a lead involves its members on its own (server team-guidance.js).
    usage: "Use team",
    usageLevels: {
      onRequest: "On request",
      suggest: "Suggest",
      autonomous: "Autonomous",
    },
    usageHints: {
      onRequest: "The agent asks or delegates to its members only when you ask it to.",
      suggest:
        "The agent offers to involve a matching member in one sentence and waits for your yes. Your yes counts as your request.",
      autonomous:
        "The agent asks members and delegates suitable tasks on its own; only many actions in a short time stop it, so that no loop runs away. Its own tasks may change the member's workspace; shell, SSH, project folders, GitHub and new teams keep their usual approvals.",
    },
    memberShellSsh: "Team members may use shell and SSH",
    memberShellSshHint:
      "Lead agents grant their task members only what they have themselves. With this option they may also grant shell, at most at their own level, and SSH on their own hosts; you approve every later grant. It applies to teams proposed while it is on. Members act unattended, and content they read can steer them.",
    permissionHint:
      "The agent asks by default. Use /team or the message option to allow one team for an assignment.",
    maxMembers: "Maximum team size",
    timeout: "Member time limit (minutes)",
    timeoutHint:
      "Applies to a team's work on its assignment and to questions. A task the agent gives a member, or a member gives a colleague, may run up to 60 minutes; questions to a member busy with one can wait that long.",
    capacity: "Concurrent members on this host",
    capacityRange: (min, max) => `Choose a value from ${min} to ${max}.`,
    concurrentHint:
      "All members may work at the same time while host capacity is available.",
    save: "Save team settings",
    permanent: "Permanent agent",
    taskBound: "Task-bound member",
    independent:
      "Model and instructions are this agent's own. Changes to the lead do not overwrite them.",
    independentTask:
      "The instructions are an independent copy that changes to the lead do not overwrite; you can change them after completion. The model follows the lead's unless the member is given one of its own.",
    promote: "Keep as permanent agent",
    states: {
      partial: "Partially successful",
      awaiting_approval: "Awaiting approval",
      approved: "Approved",
      queued: "Waiting for capacity",
      provisioning: "Setting up",
      provisioning_uncertain: "Setup outcome unknown",
      ready: "Ready",
      admitting: "Starting",
      running: "Working",
      stopping: "Stopping",
      uncertain: "Outcome unknown",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      declined: "Declined",
    },
    internalTurns: {
      "coding-start": "The agent received the outcome of the approved coding start.",
      "team-result": "Team results received. The agent is summarizing them.",
      "member-result": "A member's answer arrived. The agent is passing it on.",
      "peer-result": "A colleague's answer arrived. The agent continues.",
      "coding-result": "Coding run result received.",
      "memory-result": "A project knowledge note was not saved. The agent was told.",
      "ssh-result": "SSH command result received.",
      "sftp-result": "SFTP operation result received.",
      "mail-result": "Email send result received.",
      "ssh-access-result":
        "The outcome of an SSH access proposal was passed to the agent.",
      "memory-step": "The agent was asked to save its memories before the summary.",
      "member-long-chat": "A member's chat has grown long. The agent was told.",
      "goal-continuation": "AgentPier asked the agent to continue its goal.",
      "coding-session": "A coding session changed. The agent continues.",
    },
    // All results of a task to a group, in one turn (instead of
    // internalTurns["member-result"]).
    groupResults: (group) =>
      `Results of the group ${group} received. The agent is summarizing them.`,
    // A member's question or task that ended without a result (instead of
    // internalTurns["member-result"]).
    memberOutcomes: {
      deadline: "A member's result: cancelled (time limit)",
      owner: "A member's result: cancelled by you",
      lead: "A member's result: cancelled by the lead agent",
      stopped: "A member's result: stopped",
      cancelled: "A member's result: cancelled",
      failed: "A member's result: failed",
    },
    // The same in the asking member's chat (instead of internalTurns["peer-result"]).
    peerOutcomes: {
      deadline: "A colleague's result: cancelled (time limit)",
      owner: "A colleague's result: cancelled by you",
      lead: "A colleague's result: cancelled by the lead agent",
      stopped: "A colleague's result: stopped",
      cancelled: "A colleague's result: cancelled",
      failed: "A colleague's result: failed",
    },
    notes: {
      started: (title) => `Team started: ${title}`,
      completed: (title) => `Team completed: ${title}`,
      partial: (title) => `Team partly completed: ${title}`,
      failed: (title) => `Team failed: ${title}`,
      cancelled: (title) => `Team cancelled: ${title}`,
      declined: (title) => `Team proposal declined: ${title}`,
      unsent: (title) => `Team results could not be passed to the agent: ${title}`,
    },
    awaitingReview: "Waiting for your review",
    reviewTitle: (title) => `Review needed: ${title}`,
    reviewHint:
      "The outcome of these members is unknown. The team can only finish once you review them.",
    reviewMember: (name) => `Review ${name}`,
    pendingTitle: "Teams waiting for you",
    listHint:
      "Every team this agent started, with its members, status and results. Open a member to read its chat.",
    filterLabel: "Show teams",
    active: (count) => `Active (${count})`,
    archived: (count) => `Archived (${count})`,
    noTeams: "This agent has not started a team yet.",
    noActive: "No active teams.",
    noArchived: "No archived teams.",
    showInChat: "Show in chat",
    report: "Report",
    noReport: "No written report",
    // A report stored incomplete beyond the history limit.
    reportShortened: "Shortened – the whole report is in the member’s chat.",
    openMemberChat: "Open chat",
    results: {
      queued: "Results waiting to be summarized",
      pending: "Results are being summarized in the chat",
      accepted: "Results are being summarized in the chat",
      running: "Results are being summarized in the chat",
      completed: "Results summarized in the chat",
      failed: "The summary failed",
      cancelled: "The summary was stopped",
      interrupted: "Summary outcome unknown",
      uncertain: "Summary outcome unknown",
      reviewed: "Summary outcome reviewed",
      skipped: "No summary",
      unsent: "The results could not be passed to the agent. Read the reports here.",
    },
    inherited: (name, revision) => `Created by ${name} · inherited revision ${revision}`,
  },
  remoteChanged: (fields) =>
    `This agent changed on the server while you were editing (${fields}). Your edits are kept; reload to use the latest values instead.`,
  reloadLatest: "Reload latest",
  sidebarLabel: (name, detail, status) => `${name}, ${detail}, ${status}`,
  runtimeDiagnostics: {
    RESTART_LIMIT:
      "The agent service stopped restarting automatically after repeated failures. Restart it manually.",
    WRITE_GUARD_PENDING:
      "The agent service is running, but memory writes wait for its write guard. Agents can read memory until it reports in.",
  },
  conversationDiagnostics: {
    SESSION_UNAVAILABLE:
      "This chat's session is not available in the agent service right now. New replies may be delayed; AgentPier retries automatically.",
    AGENT_DEGRADED:
      "This agent couldn't start in the agent service. Restart the agent service to bring it back.",
  },
  restartAgentService: "Restart agent service",
  conversation: "Conversation",
  settingsTab: "Settings",
  messagePlaceholder: "Message your agent …",
  webSearch: {
    title: "Web search",
    description:
      "The search provider agents use when web search is switched on. Changes can restart the agents' service.",
    provider: "Search provider",
    duckduckgo: "DuckDuckGo (no key needed)",
    perplexity: "Perplexity (through an OpenRouter connection)",
    brave: "Brave Search (API key)",
    connection: "OpenRouter connection",
    noConnection: "Choose a connection",
    noConnections: "Add an OpenRouter connection under Model access to use Perplexity.",
    braveKey: "Brave API key",
    braveKeyStored: "Key stored",
    braveKeyMissing: "No key stored",
    removeKey: "Remove Brave key",
    ready: "Ready",
    notConfigured: "Not configured: agents cannot search the web until this is complete.",
    save: "Save search settings",
    saving: "Saving …",
  },
  speech: {
    title: "Speech recognition",
    description:
      "Use one central Deepgram connection for agent voice messages and dictation in the chats. Audio is sent to Deepgram for transcription.",
    saved: "Key saved",
    missing: "No key configured",
    key: "Deepgram API key",
    model: "Recognition model",
    language: "Recognition language",
    auto: "Detect automatically",
    german: "German",
    english: "English",
    save: "Save speech settings",
    remove: "Remove speech key",
    group: "Deepgram speech recognition",
    dictationSend: "Send dictated messages right away",
    dictationSendHint:
      "Off: the dictated text stays in the message field so you can edit it before sending.",
  },
  channel: {
    language: "Language of Telegram notices",
    languageDe: "German",
    languageEn: "English",
    languageHint:
      "Notices written by AgentPier (approvals, team updates, links) use this language. It is taken from this browser when you first connect; pairing again keeps your choice. Notices already queued keep their text; the agent’s own replies are not translated.",
    appUrl: "AgentPier address for links",
    appUrlHint:
      "Telegram notices link back to this address. It is taken from this browser when you connect or pair; leave it empty to send notices without links.",
    ignored: (privateCount, groupCount) =>
      `Ignored messages: ${privateCount} from other private chats, ${groupCount} from groups.`,
    teamNotification: "Team notification",
    fileNotification: "File shared by the agent",
    connected: (chatId) => `Connected to private chat ${chatId}`,
    description:
      "Use this agent’s shared chat from your private Telegram conversation. Replies to Telegram messages return to Telegram.",
    paused: "Paused or awaiting pairing",
    disconnected: "Disconnected",
    failed: "The channel operation could not be completed.",
    token: "Telegram bot token",
    botHint:
      "Create a dedicated bot with BotFather. A bot already used by another service must be disconnected there first.",
    connect: "Connect Telegram",
    pairHint:
      "Open the link and send the start message to pair your private chat. This code expires after ten minutes.",
    pair: "Pair my private chat",
    newPair: "Create a new pairing code",
    pause: "Pause Telegram",
    resume: "Resume Telegram",
    disconnect: "Disconnect bot",
    activity: "Telegram activity",
    voice: "Voice message",
    media: "Photo, video or file",
    retry: "Retry",
    review: "Acknowledge without resending",
    openChat: "Review agent chat",
    title: "Telegram",
    inProgress:
      "Still in progress. A review action appears here if it needs your decision.",
    states: {
      partial: "Partially successful",
      queued: "Queued",
      voice_pending: "Waiting for transcription",
      transcribing: "Transcribing",
      transcription_failed: "Transcription failed",
      dispatching: "Starting agent",
      running: "Agent working",
      model_uncertain: "Agent outcome unknown",
      model_reviewed: "Outcome reviewed in chat",
      outbound: "Waiting to send",
      delivering: "Sending reply",
      delivered: "Delivered",
      delivery_failed: "Delivery failed",
      delivery_uncertain: "Delivery outcome unknown",
      reply_unavailable: "Answer without text",
      failed: "Failed",
      cancelled: "Cancelled",
      reviewed: "Reviewed",
    },
    diagnostics: {
      FILE_UNAVAILABLE: "The shared file is no longer available in AgentPier.",
      FILE_TOO_LARGE: "The shared file is larger than Telegram accepts.",
      CHANNEL_DESTINATION_CHANGED:
        "The chat binding changed. Review this input before continuing.",
      TELEGRAM_CONFLICT: "Another service is polling this bot. Stop it before resuming.",
      TELEGRAM_WEBHOOK:
        "This bot has an existing webhook. Disconnect its other integration first.",
      TELEGRAM_UNAVAILABLE: "Telegram is currently unavailable.",
      TELEGRAM_REJECTED:
        "Telegram rejected the request. Check the bot connection and whether the chat allows messages.",
      TELEGRAM_RATE_LIMIT:
        "Telegram requested a pause. Delivery will resume after the waiting period.",
      MEDIA_TOO_LARGE: "Voice messages are limited to 10 MB and ten minutes.",
      MEDIA_UNSUPPORTED: "Only Ogg voice messages can be transcribed.",
      MEDIA_REFUSED:
        "Nothing in this message could be passed on to the agent. The Telegram chat was told what failed.",
      VOICE_TOO_LONG: "The voice message was too long and was declined before download.",
      TRANSCRIPTION_REJECTED:
        "Deepgram rejected the audio. Deepgram's response is shown below.",
      TRANSCRIPTION_QUOTA:
        "The Deepgram balance or quota is exhausted. Check your Deepgram account.",
      TRANSCRIPTION_RATE_LIMITED:
        "Deepgram still asked to slow down after several attempts. You can retry the transcription later.",
      MEDIA_DOWNLOAD: "The voice message could not be downloaded.",
      SPEECH_NOT_CONFIGURED: "Configure Deepgram in Connections before transcribing.",
      SPEECH_AUTH: "Deepgram rejected the credential. Update it in Connections.",
      TRANSCRIPTION_EMPTY: "No speech was recognized.",
      TRANSCRIPTION_FAILED: "Transcription failed. You can retry it explicitly.",
      TRANSCRIPTION_INTERRUPTED:
        "Transcription was interrupted. It was not repeated automatically.",
      MODEL_REQUEST_FAILED: "The agent request failed or was cancelled.",
      MODEL_OUTCOME_UNKNOWN:
        "Review and resolve the unknown request in the agent chat first.",
      REPLY_UNAVAILABLE: "Waiting for the confirmed reply for this request.",
      REPLY_TOO_LARGE:
        "The reply exceeds the Telegram delivery limit for this integration.",
      REPLY_WITHOUT_TEXT:
        "The agent finished without a text answer. Review it in the agent chat; nothing was sent to Telegram.",
      CHANNEL_QUEUE_FULL:
        "The Telegram queue is full. New messages are declined until queued inputs are processed or reviewed.",
      DECISION_FAILED:
        "A decision from Telegram could not be saved. Decide in AgentPier instead.",
      MODEL_OUTCOME_REVIEWED:
        "The unknown request was reviewed in the agent chat. Nothing was sent to Telegram.",
      CALLBACK_FAILED:
        "A Telegram button press could not be processed. Decide in AgentPier instead.",
      TEAM_NOTIFICATION_FAILED:
        "Telegram notifications for a team could not be prepared. Check the team in AgentPier.",
      DELIVERY_UNCERTAIN:
        "Telegram may have received the reply. Check your chat before acknowledging; nothing will be sent again automatically.",
      RUNTIME_UPDATE_CLOSED:
        "Closed without sending when you paused the agents for an OpenClaw update.",
    },
  },
  accountsTitle: "ChatGPT for agents",
  accountsDescription:
    "Connect your ChatGPT account and select it in an agent’s settings.",
  accountsOffline: "Start the agent service to manage these connections.",
  accountConnect: "Connect ChatGPT",
  accountCheck: "Check connection",
  accountDisconnect: "Disconnect",
  accountHeldByOpenClaw:
    "OpenClaw holds this login and renews it itself. Move it to AgentPier so that AgentPier renews it and Hermes agents can use it too. Your agents keep their settings.",
  accountMove: "Move this ChatGPT login to AgentPier",
  accountMoved: "The login is now held by AgentPier.",
  accountVerified: "Connection verified",
  accountCheckFailed: "Connection could not be verified. Try again or sign in again.",
  loginInstructions: "Enter this code on the OpenAI sign-in page.",
  loginOpen: "Open sign-in page",
  loginPage: "Sign-in page:",
  loginCancel: "Cancel sign-in",
  loginStatus: {
    starting: "Starting sign-in …",
    awaiting_user: "Waiting for your sign-in",
    completed: "ChatGPT connected",
    cancelled: "Sign-in cancelled",
    failed: "Sign-in failed. Please try again.",
  },
  loginFailure: {
    LOGIN_UNAVAILABLE:
      "OpenAI does not offer the sign-in with a code right now. Try again later.",
    UNSUPPORTED_LOGIN_STEP: "The sign-in asked for a step AgentPier does not support.",
    LOGIN_EXPIRED: "The code expired before the sign-in was completed.",
    CONNECTION_LOST: "The connection to the agent service was lost.",
    LOGIN_FAILED:
      "OpenAI ended the sign-in with an error. Details are in the AgentPier log.",
    NETWORK:
      "AgentPier could not reach OpenAI. Check this computer’s internet connection and try again.",
  },
  accountStatus: {
    ok: "Connected",
    expiring: "Connected · renewal due soon",
    expired: "Expired · check connection to attempt renewal",
    missing: "Sign-in required",
    invalid: "Sign-in required",
    unknown: "Status unknown",
    offline: "Service offline",
  },
  title: "Agents",
  chats: "Agent chats",
  agentsGroup: "Agents",
  sidebarOffline: "Connection lost. Showing the last known agents.",
  // Agent service stopped: sidebar rows dimmed with "offline".
  sidebarServiceOffline: "offline",
  feature: {
    title: "Enable agents",
    description:
      "Agents are managed by OpenClaw. While this is off, AgentPier shows no agent navigation or account sections and runs no agent connections or background work on this host.",
    saving: "Saving …",
    diagnostic: "Agent diagnostic",
    problem: (code) => `Agents reported a problem (${code}).`,
    errors: {
      FEATURE_CHECK_FAILED:
        "Could not check whether agents are on. AgentPier will keep trying.",
      ASSISTANT_STORAGE_UNSAFE:
        "The agent data folder is not a regular folder owned by AgentPier. Fix its ownership or remove it, then try again.",
      ASSISTANT_INITIALIZATION_FAILED:
        "Agents could not be started. Check the diagnostics and try again.",
    },
    offTitle: "Agents are off",
    offDescription: "Turn on agents in Settings to create and chat with agents.",
    openSettings: "Open agent settings",
  },
  showMembers: (count) => `Show team members (${count})`,
  hideMembers: (count) => `Hide team members (${count})`,
  description: "Persistent agents for your ideas and everyday plans.",
  create: "New agent",
  empty: "Create your first agent to start a conversation.",
  name: "Name",
  instructions: "Instructions",
  generatedInstructions: "Generated by the team lead — review before use.",
  confirmInstructions: "Mark as reviewed",
  connection: "Model connection",
  model: "Model ID",
  modelChoice: "Model",
  chooseModel: "Choose a model",
  noMatchingModels: "No matching models found.",
  customModel: "Custom model ID …",
  refreshAccountModels: "Refresh models",
  accountModelsLoading: "Loading ChatGPT models …",
  accountModelsStale:
    "The ChatGPT model list could not be refreshed and may be out of date. A custom model ID stays possible.",
  accountModelsUnverified:
    "The Gateway checked this list with another ChatGPT account. Some models may not work with this one.",
  accountModelsFailed:
    "The ChatGPT model list could not be loaded. Enter a model ID or try again later.",
  chooseConnection: "Choose a connection",
  connections: "Manage connections",
  noConnections: "Connect ChatGPT or OpenRouter in Connections to get started.",
  save: "Save agent",
  settings: "Agent settings",
  connectionUse: {
    agents: (names) =>
      `${new Intl.ListFormat("en", { type: "conjunction" }).format(names)} ${names.length === 1 ? "uses" : "use"} this provider connection. ${names.length === 1 ? "It stops" : "They stop"} working until you choose another provider connection for ${names.length === 1 ? "it" : "them"}.`,
    members: (count) =>
      `Also used by ${count} temporary team ${count === 1 ? "member" : "members"}.`,
  },
  connectionMissingHint:
    "This agent's provider connection was deleted. Choose another provider connection in the agent settings.",
  chat: "Open chat",
  revisions: (saved, applied) =>
    `Saved revision: ${saved} · Applied revision: ${applied}`,
  pendingConfig: "Saved changes apply before the next message.",
  pendingConfigShort: "Applies before the next message.",
  message: "Message",
  send: "Send",
  stop: "Stop response",
  stopShort: "Stop",
  // A second press while the message is still on its way: nothing is lost or sent twice.
  sendUnderway:
    "Your message is still on its way; it stays in the field until AgentPier confirms it.",
  // A message written while the agent works waits above the composer until it is done.
  queued: {
    send: "Send when done",
    notice: (name) => `Will be sent when ${name} is done`,
    files: (count) => (count === 1 ? "1 file" : `${count} files`),
    edit: "Edit",
    editLabel: "Edit queued message",
    label: "Queued message",
    sending: "Sending now …",
    retrying: (name) => `Not sent yet: AgentPier keeps trying to send it to ${name}`,
    blocked: (name) => `Not sent yet: ${name} can't take messages right now`,
    failed: (reason) => `Not sent: ${reason}`,
    unknownError: "The agent did not accept it.",
  },
  showApprovals: "Show",
  memberCount: (count) => (count === 1 ? "1 member" : `${count} members`),
  options: "Options",
  optionsClose: "Close options",
  backToChat: "Back to conversation",
  you: "You",
  // Under a message longer than the chat can load (65,536 characters).
  messageCut: "Shortened: the rest of this message is too long to show.",
  // Under a long message whose rest the chat has not loaded yet.
  messagePartial: "The rest of this message loads shortly.",
  // The meta line under a message that reached the agent through Telegram.
  telegramSource: {
    via: "via Telegram",
    // The meta line under the bubble, and what screen readers hear instead.
    at: (via, time) => `${via} · ${time}`,
    spokenAt: (via, time) => `${via}, ${time}`,
  },
  earlier: "Earlier messages",
  emptyChat: "What would you like to work on?",
  loading: "Loading …",
  unavailable: "This agent is not available.",
  runtimeLink: "Agents › Runtime",
  runtime: "Agent service",
  runtimeDescription: "One managed OpenClaw service runs your agents on this host.",
  enable: "Enable service",
  start: "Start service",
  stopService: "Stop service",
  restart: "Restart service",
  // An agent's runtime (ADR 0006) in its settings.
  agentRuntime: "Runtime",
  agentRuntimeDescription: (runtime) =>
    `${runtime} runs this agent in a service AgentPier manages on this host.`,
  serviceState: "Service",
  syncState: "Synchronization",
  details: "Technical details",
  version: "Runtime version",
  diagnostic: "Diagnostic code",
  disconnected:
    "Connection interrupted. Your draft is preserved; history will refresh when connected.",
  stale: "Showing saved history while the service is unavailable.",
  uncertain:
    "The previous request may have run. Its outcome is still unknown; it will not be sent again automatically.",
  recover: "Restart service and acknowledge uncertainty",
  // A sent turn whose acceptance the service has not confirmed yet.
  unconfirmed:
    "Waiting for the agent service to confirm. The request is probably running already; it will not be sent again.",
  recoverNotice:
    "Review the history first. This restarts the service and lets you continue; previous effects remain unknown. Nothing is resent automatically.",
  reviewed:
    "Unknown outcome acknowledged. Check previous effects before repeating this request.",
  pending: "Request received. Waiting for the agent.",
  error: "The agent operation could not be completed.",
  retry: "Refresh",
  future: "Telegram, voice and teams are the next integration steps.",
  status: {
    unknown: "Unknown while offline",
    connectionMissing: "Provider connection missing",
    archived: "Archived",
    disconnected: "Connection interrupted",
    disabled: "Stopped",
    installing: "Installing",
    starting: "Starting",
    ready: "Ready",
    reconnecting: "Reconnecting",
    stopping: "Stopping",
    maintenanceWindow: "Maintenance",
    failed: "Failed",
    current: "Up to date",
    reconciling: "Checking status",
    stale: "Not synchronized",
    pending: "Pending",
    accepted: "Accepted",
    running: "Working",
    completed: "Completed",
    interrupted: "Interrupted",
    uncertain: "Outcome unknown",
    unconfirmed: "Awaiting confirmation",
    cancelled: "Cancelled",
    compacting: "Summarising conversation",
    savingMemories: "Saving memories",
    degraded: "Couldn't start",
  },
  // A run that shortens its long history first (server compactions.js).
  compaction: {
    memory: "Saving memories before the summary …",
    running:
      "Summarising the conversation so far — this can take a few minutes for long chats.",
    note: (before, after) =>
      `Earlier messages were summarised (about ${before}k → ${after}k tokens).`,
    noteWithoutTokens: "Earlier messages were summarised.",
  },
  teamActive: {
    working: "Team working",
    awaiting: "Team awaiting approval",
  },
};
