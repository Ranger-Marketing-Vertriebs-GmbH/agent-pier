/** English counterpart of de/providers.js with identical keys. */
export const providers = Object.freeze({
  invalidAccessSelection: "Invalid session access selection.",
  nativeOrProviderModel: "Choose either a native model or a provider model.",
  connectionRequiredForModel: "Select a provider connection for the provider model.",
  nativeAccountToolMismatch: "The native account does not belong to the selected CLI.",
  connectionRequiresWorkSession: "Provider connections require a coding work session.",
  apiKeyRequiredForSession: "Add a provider API key before starting this session.",
  apiKeyRequiredForAccount: "Add a provider API key before starting this account.",
  connectionToolUnsupported:
    "This connection does not support the selected CLI or lacks declared Responses API access.",
  invalidModelId: "Invalid model ID.",
  modelNotInCatalog:
    "Model is not in the supported provider catalog. Refresh the catalog or select another model.",
  catalogRefreshFailed: "Catalog refresh failed; the previous catalog remains available.",
  invalidConnectionFields: "Invalid provider connection fields.",
  invalidApiKey: "Invalid provider API key.",
  invalidKeyRemoval: "Invalid key removal selection.",
  responsesAccessBoolean: "Responses API access must be an explicit boolean.",
  connectionNotFound: "Provider connection not found.",
  connectionPreparingSession:
    "A session is being prepared with this connection. Retry after the session starts.",
  responsesEntitlementZaiOnly: "Responses entitlement applies only to Z.ai connections.",
  unknownProvider: "Unknown provider.",
  invalidProviderSelection:
    "Invalid provider selection. Model limits are resolved by the server.",
  providerToolUnsupported: "This provider does not support the selected CLI.",
  zaiCodexRequiresResponses:
    "Z.ai with Codex requires an account with Responses API access. Chat-only accounts are not supported.",
  responsesAccessZaiCodexOnly: "Responses access applies only to Z.ai with Codex.",
  claudeVersionUnverified:
    "The Claude Code version could not be verified. Retry the launch; if this persists, check that the CLI responds to --version.",
  claudeVersionTooOld:
    "Custom model context configuration requires Claude Code 2.1.193 or later. Update the CLI before launching this model.",
  contextLimitUnverified:
    "This model has no verified context limit. Refresh the catalog before launching it in Claude Code.",
  managedConfigInvalid:
    "The managed provider config is invalid. Repair it before launching.",
  managedOpenCodeConfigInvalid:
    "The managed OpenCode config is invalid. Repair it before launching.",
  unsafeConnectionStorage: "Unsafe provider connection storage.",
  unsafeConnectionDirectory: "Unsafe provider connection directory.",
  invalidConnectionStorage: "Invalid provider connection storage.",
  invalidEndpoint: "Invalid custom endpoint settings.",
  invalidEndpointUrl:
    "Enter an http or https base URL without credentials, query or fragment.",
  invalidEndpointHeader: "The auth header name is not allowed.",
  invalidEndpointModels:
    "Invalid model list: check IDs, duplicates and token limits (1024 to 10,000,000).",
  endpointUrlNotAllowed:
    "This endpoint address is not allowed. Unencrypted http is only allowed for local, private or Tailscale addresses.",
  endpointHostUnresolved:
    "The endpoint host could not be resolved. Check the network, VPN or Tailscale connection.",
  endpointProtocolDisabled: "This endpoint does not offer the protocol this CLI needs.",
  endpointModelUnknown: "The model is not configured on this endpoint connection.",
  endpointContextRequired:
    "Enter the context size for this model in the endpoint connection before launching it.",
  endpointKeyReentryRequired:
    "The endpoint address changed. Enter the API key again or remove it.",
  endpointTestBusy: "Another endpoint test is running. Try again shortly.",
  endpointTestConnectionInvalid: "Only custom endpoint connections can be tested.",
  endpointClaudeCustomHeaderVersion:
    "Custom auth headers require Claude Code 2.1.227 or later. Update the CLI or use the default header.",
});
