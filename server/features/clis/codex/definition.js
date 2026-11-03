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
  minVersion: "0.153.4",
  launchModes: { default: [], yolo: ["--yolo"] },
  defaultLaunchMode: "yolo",
  unattendedModes: ["yolo"],
  loginArgs: ["login", "--device-auth"],
  authStatusArgs: ["login", "status"],
  apiKeyEnv: "OPENAI_API_KEY",
  resumeArgs: (sessionId) => ["resume", sessionId],
  configFormat: "toml",
  protocol: "responses",
  capabilities: {
    accountTransfer: true,
    transcriptCleanup: true,
    storageCleanup: true,
    mcpOAuth: true,
    imagePaste: false,
    rateLimits: true,
  },
  pipeline: { permissionModes: ["untrusted", "on-request", "never"] },
};

export default definition;
