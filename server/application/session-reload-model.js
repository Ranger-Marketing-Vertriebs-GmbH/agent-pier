import { problem } from "../lib/storage.js";

const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/:\[\]-]{0,299}$/.test(value)
    ? value
    : undefined;
const unavailable = () =>
  problem(
    "The current model cannot be preserved reliably. Confirm an exact native model before reloading.",
    409,
  );

/** Translate only known native chrome; observed IDs independently confirm Claude labels. */
export function resolveReloadModel({
  tool,
  displayedModel,
  observedModel,
  fallbackModel,
}) {
  const observed = identifier(observedModel);
  if (!displayedModel) return { modelId: observed || identifier(fallbackModel) };
  const exact = identifier(displayedModel);
  if (exact) return { modelId: exact };
  if (tool === "codex") {
    const codex = /^(\S+) (minimal|low|medium|high|xhigh)(?: effort)?$/.exec(
      displayedModel,
    );
    if (codex && identifier(codex[1]))
      return { modelId: codex[1], reasoningEffort: codex[2] };
  }
  if (tool === "claude") {
    const claude =
      /^(Opus|Sonnet|Haiku) (\d+(?:\.\d+)?)( \(1M context\))?( \(default\))?$/i.exec(
        displayedModel,
      );
    if (claude && observed) {
      const canonical = `claude-${claude[1].toLowerCase()}-${claude[2].replaceAll(".", "-")}`;
      const extended = observed.endsWith("[1m]");
      const base = extended ? observed.slice(0, -4) : observed;
      const date = base.startsWith(canonical + "-")
        ? base.slice(canonical.length + 1)
        : "";
      if ((base === canonical || /^\d{8}$/.test(date)) && (!claude[3] || extended))
        return { modelId: observed };
    }
  }
  throw unavailable();
}
