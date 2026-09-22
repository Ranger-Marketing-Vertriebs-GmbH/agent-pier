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
    unknown: {
      title: "Claude is waiting for input",
      description:
        "Claude shows a startup menu that chat does not recognize. Continue in the terminal; chat sends nothing until then.",
    },
  },
  startupOptions: {
    apiKey: { yes: "Use API key", no: "Do not use (recommended)" },
    securityNotes: { continue: "Continue" },
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
  unknown: "Delivery uncertain. Check the terminal.",
  responding: "Delivering answer …",
  required: "Please answer every question fully.",
  other: "Other answer",
  otherLabel: (prompt) => `Other answer: ${prompt}`,
  decline: "Decline",
  note: "Note for Claude (optional)",
  noteLabel: (prompt) => `Note for Claude: ${prompt}`,
  preview: (label) => `Preview: ${label}`,
  details: "Requested action",
  cwd: "Working directory",
  scopes: {
    turn: "For this turn",
    once: "Once",
    session: "This session",
    persistent: "Permanently",
  },
  loading: "Loading native requests …",
};
