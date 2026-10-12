export const mcpCliCopy = {
  legend: "Coding CLIs",
  hint: "AgentPier writes the server into each selected CLI's own configuration, for all of its accounts, so it also works when you start the CLI in a terminal. Running sessions see a change after a restart.",
  unsupported: {
    transport: "Codex does not support SSE servers.",
    cwd: "Claude Code cannot start a local command in a working directory; Codex and OpenCode can.",
  },
  removedOnSave: (cli, name) => `Saving removes ${name} from ${cli}.`,
  notGiven: (cli) => `${cli} will not get this server.`,
  statuses: {
    written: "written",
    pending: "will be written at the next save or session start",
    conflict: "edited by hand in the CLI",
    "name-taken": "the name is already used by another entry in the CLI",
    error: "could not write",
  },
  reasons: {
    unreadable: "its configuration file cannot be read",
    "too-large": "its configuration file is larger than 64 MiB and stays unchanged",
    duplicate: "the name appears in more than one of its configuration files",
    changed: "its configuration file kept changing; save again",
    layout:
      "its configuration file cannot be edited in place without changing other entries",
    "write-failed": "its configuration file cannot be written",
    failed:
      "its MCP servers could not be prepared; AgentPier tries again at the next session start",
    transport: "it does not support this connection type",
    cwd: "it cannot use a working directory",
    invalid: "it cannot take the server as it is",
  },
  statusLine: (cli, status) => `${cli}: ${status}`,
  errorWithReason: (reason) => `could not write: ${reason}`,
  overwrite: "Write AgentPier's version",
  overwriteFor: (cli, name) => `Write AgentPier's version of ${name} to ${cli}`,
  adoptChange: "Adopt the change",
  adoptChangeFor: (cli, name) => `Adopt the change to ${name} from ${cli}`,
  adopt: "Adopt",
  adoptFor: (cli, name) => `Adopt ${name} from ${cli}`,
  oauthConnected: (cli) => `Logged in in ${cli}`,
  // Codex status is read from the owner's own profile only (~/.codex).
  oauthConnectedCodex: "Logged in in your Codex profile (~/.codex)",
  oauthLoginCodex: (command) => `Log in once in your Codex profile: ${command}`,
  oauthUnknownCodex: (command) =>
    `If your Codex profile asks for a login: run ${command}`,
  oauthCodexAccounts: (command) =>
    `AgentPier-managed Codex accounts keep their own MCP logins: run ${command} in a session of that account.`,
  oauthLogin: (cli, command) => `Log in once in ${cli}: run ${command}`,
  oauthUnknown: (cli, command) => `If ${cli} asks for a login: run ${command}`,
  oauthLoginSession: (cli, command) => `Log in once: open ${command} in ${cli}`,
  oauthUnknownSession: (cli, command) =>
    `If ${cli} asks for a login: open ${command} in ${cli}`,
  agentsUsing: (names) => `Agents: ${names}`,
  clisUsing: (names) => `CLIs: ${names}`,
  unused: "Not in use yet",
  restartNote: "Running sessions see changes after a restart.",
  foundTitle: "Found in the CLIs",
  foundHint:
    "Entries you added to a CLI yourself. AgentPier leaves them untouched until you adopt them. Values are never shown.",
  foundLoading: "Looking in the CLIs…",
  adopted: (names) => `Adopted: ${names}.`,
  envReferences: (names) =>
    `Uses environment references (in ${names}) that other CLIs and agents cannot resolve; it stays in the CLI.`,
  foundNone: "Nothing else found in the CLIs.",
  foundIn: (clis) => `in ${clis}`,
  valueNames: (names) => `Values: ${names}`,
  proposedName: "Name in AgentPier",
  adoptNamed: (name) => `Adopt ${name}`,
  savedAs: (path) => `will be saved as ${path}`,
  commandMissing: "Command not found on this computer.",
  adoptAll: "Adopt all",
  notAdoptable: {
    "unsupported-fields": "Uses settings AgentPier does not manage; it stays in the CLI.",
    invalid: "Cannot be read; it stays in the CLI.",
    duplicate: "Appears in more than one configuration file; it stays in the CLI.",
  },
  adoptFailed: (name, error) => `${name}: ${error}`,
  extensionsMoved:
    "MCP servers are managed centrally under Accounts → MCP servers. Choose there which coding CLIs get a server; AgentPier writes it into this CLI's configuration.",
  openCentralList: "Open MCP servers",
  stdioCliTitle: "Give coding CLIs a local command?",
  stdioCliWarning:
    "A stdio server runs this command with your user rights. Every session of the selected CLIs starts it, also when you start the CLI in a terminal. Only add commands you trust.",
  stdioCliConfirm: "Confirm and save",
};
