export const assistantSkillsCopy = {
  title: "Skills",
  intro:
    "Skills bundled with OpenClaw teach the agent a tool, mostly a command-line program. Switch on the ones this agent may use.",
  row: "Bundled skills",
  shellOff: "Most skills run command-line programs and need shell access.",
  pageHint:
    "Only skills bundled with OpenClaw are offered. A skill is a hint, not a permission: shell access decides what the agent can run. Descriptions come from OpenClaw and stay in English.",
  search: "Search skills",
  filter: "Show",
  filters: {
    all: "All",
    on: "Switched on",
    ready: "Ready",
    missing: "Something missing",
  },
  loading: "Loading skills…",
  empty: "No skills match.",
  unavailable: "Skills can be listed while the agent service runs.",
  offlineHint:
    "You can switch these skills off now; switching skills on needs the agent service.",
  states: {
    ready: "Ready",
    missing: "Missing",
    unsupported: "Not available on this system",
    disabled: "Disabled in OpenClaw",
    unavailable: "No longer bundled with this OpenClaw version",
    shadowed:
      "Off for this agent: a skill of the same name in the agent's folders would run in its place. Your choice stays saved and applies again once that skill is gone.",
  },
  missing: {
    bins: (names) => `programs ${names}`,
    anyBins: (names) => `one of ${names}`,
    env: (names) => `environment variables or API keys ${names}`,
    config: (names) => `settings ${names}`,
    os: (names) => `operating system ${names}`,
  },
  missingLine: (parts) => `Missing: ${parts}`,
  needsShell: "Needs shell access",
  pending: "Applies at the agent's next turn",
  risks: {
    installsCode:
      "Warning: this skill can install code from outside, or write new skills.",
    steersGateway:
      "Warning: this skill steers the agent service itself. AgentPier keeps those surfaces off.",
    changesHost:
      "Warning: this skill changes this computer's security settings (SSH, firewall).",
    duplicates:
      "Warning: this skill works around a feature AgentPier manages itself (coding runs, MCP servers or the canvas).",
    secrets: "Warning: this skill reads secrets from your password manager.",
  },
  count: (on) => (on === 1 ? "1 on" : `${on} on`),
};
