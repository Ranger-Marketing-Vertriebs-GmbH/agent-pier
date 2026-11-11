import { tokens, remainingPercent, codexRemaining } from "./observability-values.js";

/**
 * From which release a Claude family runs with the 1M window by default, as a rule
 * rather than a list of ids, so the next release of a family needs no entry here.
 *
 * Sources: Claude Code's model configuration page ("Fable models, Sonnet 5 and
 * later, Haiku 5.5, and Opus 4.7 and later run with the 1M window by default";
 * "Opus 4.6 and Sonnet 4.6 reach 1M only through their `[1m]` variant",
 * https://code.claude.com/docs/en/model-config) and the model catalog inside
 * Claude Code 2.1.322 (`context: { window: 1e6, native_1m: true }` for exactly
 * these and the Mythos models, `window: 200000` for every older one).
 *
 * `later: false` marks a family whose source names one release only: a later one
 * is unknown, not assumed. A family that is not listed is unknown as well.
 */
const NATIVE_1M_FROM = {
  fable: { from: [0, 0], later: true },
  mythos: { from: [0, 0], later: true },
  opus: { from: [4, 7], later: true },
  sonnet: { from: [5, 0], later: true },
  haiku: { from: [5, 5], later: false },
};
// `claude-<family>-<major>[-<minor>]` since generation 4, `claude-<major>[-<minor>]-<family>`
// before; a minor has at most two digits, a date suffix is already removed.
const CURRENT_ID = /^claude-([a-z]+)(?:-(\d+)(?:-(\d{1,2}))?)?$/;
const LEGACY_ID = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)$/;
const ONE_M = /\[1m\]$/i;
const stripped = (value) =>
  typeof value === "string" ? value.replace(ONE_M, "").trim() : null;
/** Model id without `[1m]` and date suffix, for comparing a selection with an observation. */
const baseId = (value) =>
  stripped(value)
    ?.toLowerCase()
    .replace(/-\d{8}$/, "") || null;

/** A selection names the observed model by full id or by family alias like `sonnet`. */
const selectsObserved = (selection, observed) => {
  const chosen = baseId(selection);
  const seen = baseId(observed);
  if (!chosen || !seen) return false;
  return (
    chosen === seen || (/^[a-z]+$/.test(chosen) && seen.startsWith(`claude-${chosen}-`))
  );
};

/**
 * The window Claude Code runs a first-party model with, or null when no source says:
 * the chat then shows the usage without a window and without a percentage, which is
 * better than a percentage of the wrong window. A trailing `[1m]` selects the 1M
 * context and is 1M evidence by itself.
 */
export function assumedClaudeWindow(modelId) {
  const base = baseId(modelId);
  if (!base?.startsWith("claude-")) return null;
  if (ONE_M.test(modelId.trim())) return 1000000;
  const current = CURRENT_ID.exec(base);
  const legacy = current ? null : LEGACY_ID.exec(base);
  const [family, major, minor] = current
    ? [current[1], current[2], current[3]]
    : legacy
      ? [legacy[3], legacy[1], legacy[2]]
      : [];
  const rule = NATIVE_1M_FROM[family];
  if (!rule) return null;
  const [fromMajor, fromMinor] = rule.from;
  // Every release of the family has the window: no version needed ("claude-mythos").
  if (rule.later && fromMajor === 0) return 1000000;
  if (major === undefined) return null;
  const order = Number(major) - fromMajor || Number(minor || 0) - fromMinor;
  if (order < 0) return 200000;
  return order === 0 || rule.later ? 1000000 : null;
}

/**
 * Reported windows win, then an exact configured provider window, then (first-party
 * Claude only) the window rule above. Claude Code's transcript never reports a
 * window, so for a first-party Claude session the rule is the only source; where it
 * says nothing, the window stays unknown. A saved assumption is always re-evaluated.
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
    const oneM =
      typeof native === "string" &&
      ONE_M.test(native.trim()) &&
      selectsObserved(native, observed);
    const window = oneM
      ? 1000000
      : assumedClaudeWindow(!/^claude-/i.test(observed || "") ? native : context.modelId);
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
