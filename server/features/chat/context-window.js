import { tokens, remainingPercent, codexRemaining } from "./observability-values.js";

// Claude Code 2.1.289 model table: native 1M models, everything else 200k.
const NATIVE_1M = new Set([
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-fable-5",
  "claude-fable-5-1",
]);
const ONE_M = /\[1m\]$/i;
const stripped = (value) =>
  typeof value === "string" ? value.replace(ONE_M, "").trim() : null;
/** Model id without `[1m]` and date suffix, for comparing a selection with an observation. */
const baseId = (value) =>
  stripped(value)
    ?.toLowerCase()
    .replace(/-\d{8}$/, "") || null;

/** A trailing `[1m]` selects the 1M context beta and is 1M evidence by itself. */
export function assumedClaudeWindow(modelId) {
  const base = baseId(modelId);
  if (!base?.startsWith("claude-")) return null;
  if (ONE_M.test(modelId.trim())) return 1000000;
  if (NATIVE_1M.has(base) || /^claude-mythos(?:-|$)/.test(base)) return 1000000;
  return 200000;
}

/**
 * Reported windows win, then an exact configured provider window, then (first-party
 * Claude only) the model table. A saved assumption is always re-evaluated.
 */
export function applyContextWindow(input, session) {
  const context = { ...input };
  if (context.limitSource === "assumed-model")
    Object.assign(context, {
      limitTokens: null,
      limitSource: null,
      remainingPercent: null,
    });
  const percent = (limit) =>
    context.source === "native-token-count"
      ? codexRemaining(context.usedTokens, limit)
      : remainingPercent(context.usedTokens, limit);
  const provider = session?.provider;
  const selected = [
    provider?.cliModelId,
    provider?.requestedModelId,
    provider?.effectiveModelId,
    provider?.modelId,
  ]
    .filter((value) => typeof value === "string")
    .map(stripped);
  const observed = stripped(context.modelId);
  if (
    context.limitTokens === null &&
    provider?.contextStatus === "configured" &&
    tokens(provider.assumedContextTokens) > 0 &&
    (!observed || selected.includes(observed))
  )
    Object.assign(context, {
      limitTokens: provider.assumedContextTokens,
      limitSource: "configured",
      remainingPercent: percent(provider.assumedContextTokens),
    });
  if (context.limitTokens === null && session?.tool === "claude" && !provider) {
    // The transcript never carries `[1m]`, so a 1M selection of the observed
    // model (date suffix ignored) decides the window.
    const native = session.nativeModelId;
    const window = assumedClaudeWindow(
      !/^claude-/i.test(observed || "")
        ? native
        : typeof native === "string" &&
            ONE_M.test(native.trim()) &&
            baseId(native) === baseId(observed)
          ? native
          : context.modelId,
    );
    const used = tokens(context.usedTokens);
    if (window && !(used !== null && used > window))
      Object.assign(context, {
        limitTokens: window,
        limitSource: "assumed-model",
        remainingPercent: percent(window),
      });
  }
  return context;
}
