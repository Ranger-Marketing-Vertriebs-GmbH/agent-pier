export const assistantGithubCopy = {
  row: "GitHub",
  title: "GitHub",
  intro:
    "The agent works on GitHub with one of your token profiles: through the official GitHub MCP server and, with shell access, with gh and git. The token never appears in its instructions or files; with shell access it can read it like you can.",
  none: "No access",
  profileLegend: "Token profile",
  levelLegend: "Access",
  levels: { read: "Read", write: "Read and write" },
  levelHints: {
    read: "Repositories, issues, pull requests and Actions runs, read only.",
    write:
      "Also comments on and creates issues and pull requests, merges pull requests, pushes, changes and deletes files, runs workflows and creates, forks and deletes repositories.",
  },
  summary: (level, profile) => `${level} · ${profile}`,
  agentDefault: "Default for agents",
  noProfiles: "No GitHub token profile yet.",
  manage: "Set up token profiles",
  profileMissing: "The chosen token profile no longer exists. Choose another one.",
  missingScopes: (scopes) => `This token lacks the scope needed: ${scopes}.`,
  shellNote:
    "With shell access, gh and git in this agent's commands use this profile instead of your own login.",
  writeWarning:
    "The agent can comment, open and merge pull requests, push changes, delete files, run workflows and create, fork and delete repositories in your name without an approval per change. A deleted repository cannot always be restored. Content it reads on GitHub can steer it.",
  memoryNote:
    "Each profile and level runs its own GitHub MCP server, started for every agent session (about 45 MB of memory each).",
  server: {
    installing: "The GitHub MCP server is being installed …",
    failed: "The GitHub MCP server could not be installed.",
    retry: "Try again",
    unavailable:
      "There is no managed GitHub MCP server for this system; gh and git still work with shell access.",
    missing: "The GitHub MCP server is installed when you save.",
    ready: (version) => `GitHub MCP server ${version}`,
  },
};
