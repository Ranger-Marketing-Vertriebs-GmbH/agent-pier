import { emptyContext, tokens, list, codexRemaining } from "./observability-values.js";
export { observeClaude } from "./claude-observability.js";
export { observeCodex } from "./codex-observability.js";
export { observeOpenCode } from "./opencode-observability.js";
export function finalizeObservability(value, session, { stale = false } = {}) {
  const context = { ...emptyContext(), ...value?.context };
  const provider = session?.provider;
  const selected = [
    provider?.cliModelId,
    provider?.requestedModelId,
    provider?.effectiveModelId,
    provider?.modelId,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => value.replace(/\[1m\]$/, ""));
  const observed = context.modelId?.replace(/\[1m\]$/, "");
  if (
    context.limitTokens === null &&
    provider?.contextStatus === "configured" &&
    tokens(provider.assumedContextTokens) > 0 &&
    (!observed || selected.includes(observed))
  ) {
    context.limitTokens = provider.assumedContextTokens;
    context.limitSource = "configured";
    context.remainingPercent =
      context.source === "native-token-count"
        ? codexRemaining(context.usedTokens, context.limitTokens)
        : context.usedTokens !== null
          ? Math.round(
              Math.max(
                0,
                Math.min(100, (1 - context.usedTokens / context.limitTokens) * 100),
              ) * 10,
            ) / 10
          : null;
  }
  return {
    context,
    subagents: list(value?.subagents).map((agent) => ({
      ...agent,
      ...(session?.status !== "running" && agent.status === "running"
        ? { status: "unknown" }
        : {}),
    })),
    stale: stale || Boolean(value?.stale),
  };
}
