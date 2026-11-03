// Pure data: this file is bundled into the web app, so it imports nothing.
const definition = {
  id: "opencode",
  name: "OpenCode",
  shortName: "OpenCode",
  docsUrl: "https://opencode.ai/docs/",
  npmPackage: "opencode-ai",
  nativeInstaller: {
    url: "https://opencode.ai/install",
    shell: "/bin/bash",
    args: ["--no-modify-path"],
    directory: ".opencode/bin",
  },
  updateArgs: ["upgrade", "--method", "curl"],
  minVersion: "1.18.29",
  launchModes: { default: [], auto: ["--auto"] },
  defaultLaunchMode: "auto",
  unattendedModes: [],
  loginArgs: ["auth", "login"],
  authStatusArgs: ["auth", "list"],
  apiKeyEnv: "OPENAI_API_KEY",
  resumeArgs: (sessionId) => ["--session", sessionId],
  configFormat: "jsonc",
  protocol: "chatCompletions",
  capabilities: {
    accountTransfer: false,
    transcriptCleanup: false,
    storageCleanup: false,
    mcpOAuth: false,
    imagePaste: false,
    mcpSse: true,
    mcpStdioCwd: true,
  },
  mcpLoginCommand: (name) => `opencode mcp auth ${name}`,
  mcpSetup: ({ endpoint }) => ({
    steps: [
      {
        id: "add",
        value: JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: { agentpier: { type: "remote", url: endpoint, enabled: true } },
          },
          null,
          2,
        ),
        kind: "config",
      },
      { id: "login", value: "opencode mcp auth agentpier", kind: "command" },
      {
        id: "check",
        value: "opencode mcp list\nopencode mcp debug agentpier",
        kind: "command",
      },
      { id: "remove", value: "opencode mcp logout agentpier", kind: "command" },
    ],
    removeNote: "opencodeRemove",
  }),
  pipeline: { permissionModes: ["ask", "auto"] },
};

export default definition;
