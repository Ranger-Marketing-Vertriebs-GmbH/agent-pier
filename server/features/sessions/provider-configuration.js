const stringFields = [
  "id",
  "providerId",
  "requestedModelId",
  "effectiveModelId",
  "cliModelId",
  "modelId",
  "label",
  "contextStatus",
  "contextSource",
  "source",
  "fetchedAt",
];
const tokenFields = [
  "contextTokens",
  "routingContextTokens",
  "outputTokens",
  "assumedContextTokens",
];

/** Persist configured capabilities without copying credentials or arbitrary catalog payloads. */
export function publicProviderConfiguration(provider) {
  if (!provider || typeof provider !== "object") return null;
  const result = {};
  for (const key of stringFields) {
    const value = provider[key];
    if (value === null || (typeof value === "string" && value.length <= 2048))
      result[key] = value;
  }
  for (const key of tokenFields) {
    const value = provider[key];
    if (value === null || (Number.isSafeInteger(value) && value > 0 && value <= 10000000))
      result[key] = value;
  }
  if (typeof provider.modelChangeRequiresRestart === "boolean")
    result.modelChangeRequiresRestart = provider.modelChangeRequiresRestart;
  return result;
}
