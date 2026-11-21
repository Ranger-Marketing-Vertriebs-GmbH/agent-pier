// Pure data: this file is bundled into the web app, so it imports nothing.
const definition = {
  id: "codex",
  name: "Codex",
  shortName: "Codex",
  docsUrl: "https://learn.chatgpt.com/docs/codex/cli",
  npmPackage: "@openai/codex",
  nativeInstaller: {
    url: "https://chatgpt.com/codex/install.sh",
    shell: "/bin/sh",
    args: [],
    directory: ".local/bin",
  },
  updateArgs: ["update"],
  minVersion: "0.169.1",
  launchModes: { default: [], yolo: ["--yolo"] },
  defaultLaunchMode: "yolo",
  unattendedModes: ["yolo"],
  unattendedArgs: [],
  loginArgs: ["login", "--device-auth"],
  authStatusArgs: ["login", "status"],
  apiKeyEnv: "OPENAI_API_KEY",
  resumeArgs: (sessionId) => ["resume", sessionId],
  // Arguments that pin the native session id to AgentPier's own at launch, or null.
  sessionIdArgs: null,
  // The CLI's own operating-system sandbox mode for an attachment grant, or null.
  nativeSandbox: "workspace-write",
  // How the chat shows one app-server question.
  questionView: (q) => ({
    multiple: false,
    allowOther: q.isOther === true || !q.options?.length,
    previews: false,
    notes: false,
  }),
  configFormat: "toml",
  // The file a binding from Connections › MCP servers writes: the built-in local
  // profile, i.e. the owner's own home configuration that every account shares.
  mcpHomeConfig: "~/.codex/config.toml",
  protocol: "responses",
  capabilities: {
    accountTransfer: true,
    transcriptCleanup: true,
    storageCleanup: true,
    mcpOAuth: true,
    imagePaste: false,
    mcpSse: false,
    endpointSdkRouting: false,
    mcpStdioCwd: true,
    requestHandoff: false,
    hookTrust: true,
    keychainCredentials: false,
    transcriptIndex: true,
    npmPlugins: false,
    pluginBridge: false,
    clearResetsBinding: true,
  },
  mcpLoginCommand: (name) => `codex mcp login ${name}`,
  mcpSetup: ({ quoted }) => ({
    steps: [
      { id: "add", value: `codex mcp add agentpier --url ${quoted}`, kind: "command" },
      {
        id: "login",
        value: "codex mcp login agentpier --oauth-client-registration dcr",
        kind: "command",
        label: "retryLogin",
      },
      { id: "check", value: "codex mcp get agentpier\ncodex mcp list", kind: "command" },
      {
        id: "remove",
        value: "codex mcp logout agentpier\ncodex mcp remove agentpier",
        kind: "command",
      },
    ],
  }),
  // Codex 0.169 accepts only these approval policies; profiles and runs saved with the
  // removed "untrusted" run with its closest successor (AGENTPIER-427).
  pipeline: {
    permissionModes: ["on-request", "never"],
    legacyPermissionModes: { untrusted: "on-request" },
  },
};

export default definition;
