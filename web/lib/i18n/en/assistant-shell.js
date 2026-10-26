export const assistantShellCopy = {
  title: "Shell access",
  intro: "Lets the agent run command-line programs on this computer.",
  levels: {
    off: "Off",
    approval: "With approval",
    full: "Full access",
  },
  levelHints: {
    off: "The agent cannot run new commands. Commands it already started in the background keep running until they end; on Linux, a restart of the agent service also ends them.",
    approval: "The agent asks you before every command that is not always allowed.",
    full: "The agent runs every command without asking you.",
  },
  offHint:
    "Without shell access, skills and tools that need command-line programs do not work, for example gh, git or mail programs.",
  warning:
    "With shell access the agent works as your user account: with your logins, your files and your keys, and it can read AgentPier's own data. The team write guard does not cover shell commands.",
  temporary:
    "Task-bound team members get shell access only when their lead agent allows it under Team, and at most at the lead's level.",
  archived: "Archived agents have no shell access.",
  pending: "The new shell level applies as soon as the agent service is back.",
  badge: {
    approval: "Shell: approval",
    full: "Shell: full",
  },
  badgeLabel: (level) => `Shell access: ${level}`,
  confirmTitle: "Turn on shell access?",
  confirm: "Turn on shell access",
  fullTitle: "Run every command without asking?",
  fullBody:
    "With full access there are no prompts at all: the agent runs every command right away, including commands that delete files or send data. You cannot stop a command before it runs.",
  confirmFull: "Allow without prompts",
  allowlist: "Always allowed commands",
  allowlistHint:
    'Programs and commands you allowed with "Always allow". Delete an entry and the agent asks again.',
  allowlistEmpty: "No always allowed commands.",
  allowlistLoading: "Loading allowed commands …",
  sources: {
    agentpier: "Added by AgentPier",
    openclaw: "Added by OpenClaw",
    other: "Added elsewhere",
  },
  anyArguments: "With any arguments",
  exactArguments: "Only with the approved arguments in the approved folder",
  commandEntry: "Exact command",
  command: "Command",
  folder: "Folder",
  lastUsed: (time) => `Last used ${time}`,
  linked: (count) => `Linked command entries: ${count}`,
  remove: "Delete",
  removeLabel: (pattern) => `Remove entry ${pattern}`,
  removeTitle: (pattern) => `Remove the entry ${pattern}?`,
  removeBody: "The agent asks for approval again before it runs this command.",
  removeNow: "Remove now",
  exec: {
    history: "Shell command",
    title: "Shell command awaiting approval",
    agent: "Agent",
    folder: "Folder",
    expires: (time) => `Expires ${time}`,
    showFull: "Show full command",
    showLess: "Show less",
    allowOnce: "Allow once",
    allowAlways: "Always allow",
    deny: "Deny",
    note: "OpenClaw notes",
    alwaysPrograms: (programs) =>
      `"Always allow" lets this agent run these without asking from now on, each with any arguments: ${programs}. Some programs can run other commands through their arguments, such as git hooks or aliases; "Always allow" covers that too. You can delete the entries in the agent settings.`,
    writable: (programs) =>
      `In folders you can write to: ${programs}. If one of them is changed or replaced, the agent runs the new version without asking. OpenClaw always denies commands with redirections (> or <) for such programs.`,
    alwaysOnce: (reason) =>
      `"Always allow" allows this command only once: ${reason}. This kind of command asks again next time.`,
    confirmAlways: "Always allow these programs",
    back: "Back",
    onceReasons: {
      interpreter: (program) => `${program} is an interpreter, shell or launcher`,
      inline: (program) => `${program} runs an inline script`,
      unresolved: (program) => `AgentPier cannot tie ${program} to a fixed program path`,
    },
    onceCommandReasons: {
      inline: "the command runs an inline script",
      unresolved: "AgentPier cannot tie the command to a fixed program",
      complex:
        "the command uses shell syntax AgentPier cannot tie to fixed programs, such as variables, environment assignments, command substitution, subshells, control structures or background jobs",
    },
  },
};
