// Pure data: this file is bundled into the web app, so it imports nothing.
const definition = {
  id: "claude",
  name: "Claude Code",
  shortName: "Claude",
  docsUrl: "https://code.claude.com/docs/en/setup",
  npmPackage: "@anthropic-ai/claude-code",
  nativeInstaller: {
    url: "https://claude.ai/install.sh",
    shell: "/bin/bash",
    args: [],
    directory: ".local/bin",
  },
  updateArgs: ["update"],
  minVersion: "2.1.263",
  launchModes: {
    default: [],
    auto: ["--permission-mode", "auto"],
    bypass: ["--dangerously-skip-permissions"],
  },
  defaultLaunchMode: "auto",
  unattendedModes: ["bypass"],
  unattendedArgs: ["bypassPermissions"],
  loginArgs: [],
  authStatusArgs: ["auth", "status", "--json"],
  apiKeyEnv: "ANTHROPIC_API_KEY",
  resumeArgs: (sessionId) => ["--resume", sessionId],
  // How the chat shows one AskUserQuestion question.
  questionView: (q) => ({
    multiple: q.multiSelect === true,
    allowOther: true,
    previews: true,
    notes: true,
  }),
  configFormat: "json",
  protocol: "messages",
  capabilities: {
    accountTransfer: true,
    transcriptCleanup: true,
    storageCleanup: true,
    mcpOAuth: false,
    imagePaste: true,
    mcpSse: true,
    endpointSdkRouting: false,
    mcpStdioCwd: false,
    requestHandoff: true,
    hookTrust: false,
    keychainCredentials: true,
    transcriptIndex: false,
    npmPlugins: false,
    pluginBridge: false,
    clearResetsBinding: false,
  },
  mcpLoginCommand: () => "/mcp",
  mcpSetup: ({ quoted }) => ({
    steps: [
      {
        id: "add",
        value: `claude mcp add --transport http --scope user agentpier ${quoted}`,
        kind: "command",
      },
      { id: "login", value: "/mcp", kind: "command" },
      {
        id: "check",
        value: "claude mcp get agentpier\nclaude mcp list",
        kind: "command",
      },
      {
        id: "remove",
        value: "claude mcp remove --scope user agentpier",
        kind: "command",
      },
    ],
  }),
  pipeline: {
    permissionModes: [
      "default",
      "manual",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ],
  },
};

export default definition;
