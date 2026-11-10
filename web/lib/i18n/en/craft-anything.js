export const craftAnythingCopy = {
  title: "Craft Anything",
  searchLabel: "Craft Anything",
  intro:
    "Craft Anything gives Claude Code tools to examine applications and the skill to use them. AgentPier downloads the pinned version, checks its size and SHA-256 and keeps it in its own folder, apart from your own configuration. Installing it registers Craft Anything with the CLIs it is bound to (Claude Code by default) and copies its skill into those CLIs' profiles.",
  loading: "Loading Craft Anything …",
  componentsLabel: "Components",
  core: "Craft Anything",
  coreDescription:
    "The Craft Anything CLI as an MCP server, with its skill. Always included.",
  deepMode: "Deep mode for sessions",
  deepModeHint:
    "When off, sessions work in clean room mode: they read nothing inside a target and use only the tools that work from outside. When on, they may also look inside a target, for example decompile it with Ghidra.",
  responsibleLabel: "Responsible use",
  responsibleOwn: "Examine only software you own or are allowed to examine.",
  responsibleBypass:
    "Never use Craft Anything to bypass DRM, logins or anti-cheat systems.",
  responsibleAlpha: "Craft Anything is in early alpha. Expect rough edges and changes.",
  responsibleRestricted:
    "Sessions get its analysis tools in restricted mode: they never run the examined code and never start rebuilds.",
  responsibleCleanRoom:
    "Sessions work in clean room mode by default. Deep mode is your choice below.",
  acknowledge:
    "I understand these notes and use Craft Anything only on software I own or am allowed to examine.",
  updateNote: (parts) => `An update is available: ${parts}.`,
  updateCore: (version) => `Craft Anything ${version}`,
  runningOlder: (versions) =>
    `Running sessions keep using version ${versions} until they reload.`,
  statusRunning: "Craft Anything is being changed …",
  backgroundNote:
    "You can close this window. Craft Anything continues in the background.",
  remove: "Remove Craft Anything",
  removeTitle: "Remove Craft Anything?",
  removeBody:
    "AgentPier removes Craft Anything's MCP server, its skill copies, the CLI and its settings. Ghidra and the Java runtime go too, unless REA still uses them. Running sessions keep the tools until they reload.",
};
