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
  loginArgs: [],
  authStatusArgs: ["auth", "status", "--json"],
  apiKeyEnv: "ANTHROPIC_API_KEY",
  resumeArgs: (sessionId) => ["--resume", sessionId],
  protocol: "messages",
  capabilities: {
    accountTransfer: true,
    transcriptCleanup: true,
    storageCleanup: true,
    mcpOAuth: false,
    imagePaste: true,
    rateLimits: false,
  },
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
