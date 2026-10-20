export const requestCopy = {
  reloadRequired:
    "This Claude session needs a one-time update for chat questions. Run /reload-plugins in the terminal. Your conversation stays open.",
  legacyQuestion:
    "Claude asked a question, but this session did not send its choices to chat. Answer in the terminal, then run /reload-plugins.",
  hookTrustTitle: "Review Codex hooks",
  hookTrustDescription:
    "Codex is waiting for hook approval. Trusted hooks can run outside the sandbox. Your chat draft is preserved until you decide.",
  hookTrustAllow: "Trust hooks and continue",
  hookTrustSkip: "Continue without trusting",
  folderTrustTitle: "Trust Claude workspace",
  folderTrustDescription:
    "Claude is waiting for permission to read, edit and execute files in this workspace. Your chat draft is preserved until you decide.",
  folderTrustAllow: "Trust folder and continue",
  folderTrustExit: "Exit session",
  startup: {
    theme: {
      title: "Choose Claude text style",
      description:
        "Claude asks for the terminal text style on its first start. You can change it later with /theme. Your chat draft is preserved until you decide.",
    },
    apiKey: {
      title: "Confirm API key for Claude",
      description:
        "Claude detected this account's API key in its environment and asks whether to use it.",
    },
    securityNotes: {
      title: "Claude security notes",
      description:
        "Claude shows security notes on its first start. You are responsible for Claude's actions and should review them, especially when running code.",
    },
    login: {
      title: "Claude login required",
      description:
        "This account is not logged in yet. Login needs a browser code and is completed in the terminal.",
    },
    autoModeDefault: {
      title: "Make auto mode the default?",
      description:
        "Claude asks whether auto mode should become this account's default permission mode. In auto mode Claude checks each tool call for risky actions, runs those it assesses as lower-risk and blocks the rest. Your chat draft is preserved until you decide.",
    },
    autoModeBilling: {
      title: "Claude auto mode billing notice",
      description:
        "Claude reports that this session's auto mode classifier requests are still billed as before. Continuing keeps auto mode working; cancelling interrupts the action that is waiting. Your chat draft is preserved until you decide.",
    },
    unknown: {
      title: "Claude is waiting for input",
      description:
        "Claude shows a startup menu that chat does not recognize. Continue in the terminal; chat sends nothing until then.",
    },
  },
  startupOptions: {
    apiKey: { yes: "Use API key", no: "Do not use (recommended)" },
    securityNotes: { continue: "Continue" },
    autoModeDefault: {
      accept: "Make auto mode the default",
      decline: "Keep the current mode",
    },
    autoModeBilling: { continue: "Continue in auto mode", cancel: "Cancel the action" },
  },
  title: "Native requests",
  permission: "Approval required",
  question: "Answer required",
  progress: (current, total) => `Question ${current} of ${total}`,
  next: "Next question",
  previous: "Previous question",
  answer: "Send answer",
  handoff: "Answer in terminal",
  terminal: "Open terminal",
  terminalApproval: "Approval moved to the terminal.",
  dismissNotice: "Dismiss",
  unknown: "Delivery uncertain. Check the terminal.",
  responding: "Delivering answer …",
  required: "Please answer every question fully.",
  other: "Other answer",
  otherLabel: (prompt) => `Other answer: ${prompt}`,
  decline: "Decline",
  declineConfirm: "Confirm decline",
  note: "Note for Claude (optional)",
  noteLabel: (prompt) => `Note for Claude: ${prompt}`,
  preview: (label) => `Preview: ${label}`,
  details: "Requested action",
  claudeOptions: {
    allow: "Allow once",
    always: "Always allow",
    deny: "Deny",
  },
  alwaysRules:
    "Always allow saves these rules for this Claude account, in every project:",
  planTitle: "Plan ready for review",
  plan: "Proposed plan",
  planHint: "Keep planning stops Claude so you can send feedback in chat.",
  planOptions: {
    acceptEdits: "Approve and auto-accept edits",
    approve: "Approve and review each edit",
    keep: "Keep planning",
  },
  cwd: "Working directory",
  scopes: {
    turn: "For this turn",
    once: "Once",
    session: "This session",
    persistent: "Permanently",
  },
  loading: "Loading native requests …",
};
