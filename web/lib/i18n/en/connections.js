export const connectionCopy = {
  description:
    "Save one API key per provider connection and use it with compatible CLIs: OpenRouter, Z.ai, Azure OpenAI or local models with Ollama and llama.cpp. Choose the CLI, model and launch mode for each session.",
  add: "Add provider connection",
  name: "Connection name",
  key: "API key",
  save: "Save connection",
  provider: "API provider",
  loading: "Loading providers …",
  empty:
    "No shared provider connections yet. Add one for OpenRouter, Z.ai, Azure OpenAI or local models with Ollama and llama.cpp.",
  native: "Native CLI accounts",
  legacy: "Existing provider binding · only for this CLI",
  legacyHelp:
    "This older provider binding can still be edited. Manage new shared API connections under “Shared provider connections”.",
  providerNames: {
    "openai-chatgpt": "ChatGPT",
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
  delete: "Delete connection",
  deleteTitle: (name) => `Delete the connection “${name}”?`,
  deleteNow: "Delete now",
  restartRequired:
    "Agents use this connection. Applying the change restarts their Gateway, so agents are briefly unavailable.",
  saveAndRestart: "Save and restart agents",
  deleteAndRestart: "Delete and restart agents",
  deleteConfirm: (name, hasKey) =>
    `Delete provider connection “${name}”${hasKey ? " and its saved key" : ""}? New sessions will no longer be able to use this connection. Existing sessions and their history will be preserved.`,
  responses: "Responses API access confirmed",
  responsesHelp:
    "My Z.ai connection allows the Responses API for Codex. This is my own confirmation, not an automatic check.",
  noCompatible: "No compatible CLI available",
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
  routes: {
    native: "native",
    adapter: (protocol) => `via adapter · ${protocol}`,
    notOffered: "not offered",
    shortNames: {
      messages: "Messages",
      responses: "Responses",
      chatCompletions: "Chat Completions",
    },
  },
  endpoint: {
    routing: {
      title: "CLIs and routes",
      help: "Automatic uses the CLI's native protocol and otherwise the protocol adapter (Responses before Messages before Chat Completions). OpenCode uses its own providers for Responses before Chat Completions before Messages.",
      select: (cli) => `Route for ${cli}`,
      choices: {
        auto: "Automatic",
        native: (protocol) => `Native (${protocol})`,
        adapter: (protocol) => `Via adapter (${protocol})`,
        sdk: (protocol) => protocol,
        off: "Off",
      },
      resolved: (route) => `Uses: ${route}`,
      unavailable: (reason) => `Not available: ${reason}`,
      choiceUnavailable: (choice, reason) => `${choice} – not available: ${reason}`,
      reasons: {
        protocolOff: "protocol not enabled",
        anthropicUrlMissing: "Anthropic-compatible base URL missing",
        openaiUrlMissing: "OpenAI-compatible base URL missing",
        other: "requirement not met",
      },
    },
    adapter: {
      title: "Adapter options",
      none: "No CLI uses the protocol adapter with these settings.",
      source: (protocol) => `Adapter options · ${protocol}`,
      reset: "Restore defaults",
      proposed: "suggested by the test",
      standard: "default",
      edited: "changed by you",
      resetFor: (protocol) => `Restore defaults for ${protocol}`,
      applied: "Adapter options updated with the test suggestions.",
      appliedKept:
        "Adapter options updated with the test suggestions. Options you changed keep your value.",
      restored: (protocol) => `Defaults restored for ${protocol}.`,
      thinkInactive:
        "Inactive: no CLI uses an adapter route over Chat Completions with these settings.",
      capabilities: {
        promptCache: "Set prompt cache breakpoints",
        thinkingBudget:
          "Send thinking as a token budget (models without adaptive thinking)",
        promptCacheKey: "Send prompt_cache_key",
        reasoningEffort: "Send reasoning effort",
        parallelToolCalls: "Forward parallel_tool_calls",
        streamUsage: "Request token usage in the stream",
        reasoningReplay: "Send reasoning text back (DeepSeek, GLM, Kimi thinking modes)",
        systemMessages: "System messages in the middle of a conversation",
        maxTokensField: "Output limit field",
      },
      choices: {
        merge: "Merge into the next user message",
        inline: "Keep as system messages",
        max_tokens: "max_tokens",
        max_completion_tokens: "max_completion_tokens",
      },
      think: "Read <think> tags as reasoning",
      thinkHelp:
        "Only for adapter routes over Chat Completions, for models that write their reasoning into the answer text.",
    },
    preset: "Server type",
    presets: {
      ollama: "Ollama",
      llamacpp: "llama.cpp",
      azure: "Azure OpenAI",
      custom: "Custom (OpenAI/Anthropic compatible)",
    },
    presetHelp: {
      azure:
        "Base URL: https://<resource>.openai.azure.com/openai/v1 with the name of your Azure OpenAI resource, or paste a deployment's target URI. Models are your deployment names with their context size; the key is sent in the api-key header.",
      custom:
        "For LM Studio, vLLM, LiteLLM and any other OpenAI- or Anthropic-compatible server.",
    },
    openaiBaseUrl: "OpenAI-compatible base URL",
    openaiHelp:
      "Usually ends with /v1. Used for the Responses and Chat Completions protocols.",
    advanced: "Advanced",
    anthropicBaseUrl: "Anthropic-compatible base URL",
    anthropicHelp:
      "Used for the Anthropic Messages protocol. Leave empty if the server has no Anthropic Messages API.",
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
    probeHint: "For Azure OpenAI choose one of your deployments as test model.",
    protocols: "Protocols",
    protocolNames: {
      messages: "Anthropic Messages",
      responses: "OpenAI Responses",
      chatCompletions: "OpenAI Chat Completions",
    },
    // Every CLI can use every protocol (natively or via the adapter); only the native
    // pairing of Claude Code and Codex is named (OpenCode uses every protocol natively).
    nativeFor: {
      messages: "native for Claude Code",
      responses: "native for Codex",
    },
    statuses: {
      ok: "Available",
      unsupported: "Not supported",
      failed: "Failed",
      skipped: "Not tested",
    },
    reasons: {
      notFound: "Endpoint not found",
      modelNotFound: "Model not found on the server",
      auth: "Authentication failed (401/403)",
      http: "Unexpected server response",
      invalidKey: "The API key contains characters that cannot be sent",
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
      azureBaseModels:
        "Azure lists the base models of the resource, not your deployments, so they were not added. Add your deployment names as models.",
      deploymentRequired:
        "Add a deployment name as a model below, then test again to check the protocols.",
    },
    contextNeeded: (count) =>
      count === 1
        ? "Enter the context size of this model. No server reports it, and sessions and agents cannot use the model without it:"
        : "Enter the context size of these models. No server reports it, and sessions and agents cannot use the models without it:",
    contextAsk:
      "Save again to save without a context size. The model stays unusable until you enter one.",
    setContext: (id) => `Context of ${id}`,
    noProtocol:
      "No protocol is ticked, so no CLI can use this connection and the “New session” dialog does not list it. Tick at least one protocol.",
    deploymentFromUrl: (name) =>
      `Base URL taken from the deployment URL. Deployment ${name} was added as a model; enter its context size below.`,
    notListed:
      "The model list could not be read. Previously detected and manual models are kept.",
    notListedNetwork:
      "The server could not be reached, so nothing was tested. Check the address and that the server is running.",
    notListedAuth:
      "Authentication failed (401/403): the server rejected the API key. Check the key and the header.",
    models: "Models",
    modelId: "Model ID",
    context: "Context",
    output: "Max output",
    source: "Source",
    images: "Images",
    imagesFor: (id) => `Images ${id}`,
    imageChoices: { auto: "Automatic", yes: "Yes", no: "No" },
    imagesHelp:
      "No makes the adapter refuse image input for this model, and Codex lists it without image input.",
    sources: { detected: "Detected", manual: "Manual" },
    contextHint: (tokens) => `max. ${tokens}`,
    contextMissing: "Required",
    addModel: "Add model",
    removeModel: (id) => `Remove ${id}`,
    azureHint: "Azure OpenAI: enter your deployment names as model IDs.",
    noModels: "No models yet. Test the connection or add a model.",
    modelProblems: {
      invalidId:
        "This model ID cannot be used. Use letters, digits and . _ : + ~ - without spaces or a leading slash.",
      duplicate: "This model ID appears more than once.",
      contextRange: "Context must be a whole number from 1,024 to 10,000,000.",
      outputRange: "Max output must be a whole number from 1,024 to 10,000,000.",
      outputOverContext: "Max output must not exceed the context.",
    },
    tooManyModels: (max) => `A connection holds at most ${max} models. Remove some.`,
  },
};
