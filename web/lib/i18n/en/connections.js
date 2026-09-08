export const connectionCopy = {
  title: "Shared provider connections",
  description:
    "Save one API key per provider connection and use it with compatible CLIs. Choose the CLI, model and launch mode for each session.",
  add: "Add provider connection",
  edit: "Edit provider connection",
  name: "Connection name",
  key: "API key",
  save: "Save connection",
  provider: "API provider",
  loading: "Loading providers …",
  empty: "No shared provider connections yet.",
  native: "Native CLI accounts",
  legacy: "Existing provider binding · only for this CLI",
  legacyHelp:
    "This older provider binding can still be edited. Manage new shared API connections under “Shared provider connections”.",
  providerNames: {
    openrouter: "OpenRouter",
    zai: "Z.ai API",
    "zai-coding-plan": "Z.ai Coding Plan",
  },
  keySaved: "API key saved",
  keyMissing: "API key missing",
  keyPlaceholder: "Leave empty to keep the saved key",
  keyOptional: "Can also be added later",
  keyHelp:
    "The key is stored centrally. Changes apply to new sessions; running native processes are not stopped.",
  removeKey: "Remove saved API key",
  editNamed: (name) => `Edit ${name}`,
  deleteNamed: (name) => `Delete ${name}`,
  delete: "Delete connection",
  deleteConfirm: (name) =>
    `Delete provider connection “${name}” and its saved key? New sessions will no longer be able to use this connection. Existing sessions and their history will be preserved.`,
  responses: "Responses API access confirmed",
  responsesHelp:
    "My Z.ai connection allows the Responses API for Codex. This is my own confirmation, not an automatic check.",
  compatible: "Compatible CLIs",
  noCompatible: "No compatible CLI available",
  accountDescription:
    "Native sign-ins remain tied to their respective CLI. Shared API connections are managed separately.",
  cli: "CLI",
  access: "Connection",
  nativeModel: "Native model (optional)",
  nativeModelHelp:
    "Leave empty for the CLI default or enter an exact native model ID. You can also open model selection in a running session.",
  nativeDefault: "CLI default",
  noAccess: "No compatible connection",
  isolated:
    "This provider connection uses its own CLI profile. Sign-ins, MCP configuration and plugins from native accounts are not inherited.",
  legacyLaunch:
    "This existing provider binding uses its saved model. Use a shared provider connection to choose a model independently.",
  chooseAccess: "Please choose a compatible connection and an available model.",
  directoryPlaceholder: "/path/to/project",
};
