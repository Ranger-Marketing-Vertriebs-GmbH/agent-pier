export const assistantSkillsCopy = {
  title: "Skills",
  intro:
    "Skills teach the agent a tool, mostly a command-line program. Switch on the bundled or catalog skills this agent may use; install catalog skills in Agents › Skills.",
  row: "Skills",
  shellOff: "Most skills run command-line programs and need shell access.",
  pageHint:
    "Skills bundled with OpenClaw and skills from the skill catalog are offered; install catalog skills in Agents › Skills. A skill is a hint, not a permission: shell access decides what the agent can run. Descriptions come from OpenClaw and stay in English.",
  search: "Search skills",
  filter: "Show",
  filters: {
    all: "All",
    on: "Switched on",
    ready: "Ready",
    missing: "Something missing",
    catalog: "From the catalog",
  },
  loading: "Loading skills …",
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
    needsSettings: "Needs settings \u2014 not supported yet",
    damaged: "Damaged \u2014 install it again in Agents \u203a Skills",
    shadowedCatalog:
      "Off: a bundled skill of the same name replaces this catalog skill. Remove the catalog skill to use the bundled one.",
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
  fromCatalogPlain: "From the skill catalog",
  fromCatalog: (version) => `From the skill catalog \u00b7 version ${version}`,
  worksWithLimits:
    "Works with limits: it runs programs and this agent has no shell access.",
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
