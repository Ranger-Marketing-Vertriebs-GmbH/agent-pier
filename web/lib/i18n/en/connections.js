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
    endpoint: "Custom endpoint",
  },
  keySaved: "API key saved",
  keyNotRequired: "No API key required",
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
  endpoint: {
    preset: "Server type",
    presets: {
      ollama: "Ollama",
      llamacpp: "llama.cpp",
      custom: "Custom (OpenAI/Anthropic compatible)",
    },
    openaiBaseUrl: "OpenAI-compatible base URL",
    openaiHelp:
      "Usually ends with /v1. Used by Codex (Responses) and OpenCode (Chat Completions).",
    advanced: "Advanced",
    anthropicBaseUrl: "Anthropic-compatible base URL",
    anthropicHelp:
      "Used by Claude Code. Leave empty if the server has no Anthropic Messages API.",
    authHeader: "Auth header name",
    authHeaderHelp:
      "Leave empty to send the key as Authorization: Bearer. Example: api-key.",
    keyOptional: "Optional for local servers",
    keyReentry: "The address changed. Enter the API key again or remove it.",
    test: "Test connection",
    testing: "Testing …",
    testCost:
      "The test sends a few tokens per protocol. Paid endpoints may charge for them.",
    probeModel: "Test model",
    probeAuto: "Automatic",
    protocols: "Protocols",
    protocolNames: {
      messages: "Anthropic Messages",
      responses: "OpenAI Responses",
      chatCompletions: "OpenAI Chat Completions",
    },
    enables: { messages: "Claude Code", responses: "Codex", chatCompletions: "OpenCode" },
    statuses: {
      ok: "Available",
      unsupported: "Not supported",
      failed: "Failed",
      skipped: "Not tested",
    },
    reasons: {
      notFound: "Endpoint not found",
      modelNotFound: "Model not found on the server",
      auth: "Authentication failed",
      http: "Unexpected server response",
      invalidResponse: "Unreadable response",
      timeout: "Timed out",
      network: "Server not reachable or address not allowed",
      tooLarge: "Response too large",
      aborted: "Cancelled",
    },
    warnings: {
      ollamaContextUnknown:
        "Ollama does not report the loaded context for some models. Confirm the context size; the model maximum is only a hint.",
      modelIdSkipped:
        "Some model IDs could not be used (for example file paths). Start llama.cpp with --alias or add the model manually.",
      storedKeyNotUsed: "The saved key was not sent because the address changed.",
      rejectedRequest:
        "The server rejected the minimal test request but the endpoint exists.",
      modelListTruncated:
        "A connection holds at most 200 models. Manual models are kept; some detected models were left out.",
    },
    notListed:
      "The model list could not be read. Previously detected and manual models are kept.",
    models: "Models",
    modelId: "Model ID",
    context: "Context",
    output: "Max output",
    source: "Source",
    sources: { detected: "Detected", manual: "Manual" },
    contextHint: (tokens) => `Model maximum: ${tokens}`,
    contextMissing: "Context required",
    addModel: "Add model",
    removeModel: (id) => `Remove ${id}`,
    azureHint: "Azure OpenAI: enter your deployment names as model IDs.",
    noModels: "No models yet. Test the connection or add a model.",
  },
};
