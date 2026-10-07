import { serverMessages } from "../lib/i18n/de.js";
import { problem } from "../lib/storage.js";

const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/:\[\]-]{0,299}$/.test(value)
    ? value
    : undefined;
const unavailable = () => problem(serverMessages.sessionReload.modelNotPreservable, 409);

/** Translate only known native chrome; observed IDs independently confirm Claude labels. */
export function resolveReloadModel({
  tool,
  displayedModel,
  observedModel,
  fallbackModel,
  codexModels,
}) {
  const observed = identifier(observedModel);
  if (!displayedModel) return { modelId: observed || identifier(fallbackModel) };
  if (tool === "codex") {
    const lookup = (name) => {
      const matches = new Set(
        (codexModels || [])
          .filter((model) => model.label === name || model.modelId === name)
          .map((model) => identifier(model.modelId))
          .filter(Boolean),
      );
      if (matches.size > 1) throw unavailable();
      if (matches.size) return [...matches][0];
      const exact = identifier(name);
      if (exact && (!codexModels || exact === observed || exact === fallbackModel))
        return exact;
      return undefined;
    };
    const exact = lookup(displayedModel);
    if (exact) return { modelId: exact };
    const codex =
      /^(.*?) (none|minimal|low|medium|high|xhigh|max|ultra)(?: effort)?$/.exec(
        displayedModel,
      );
    const modelId = codex && lookup(codex[1]);
    if (modelId) return { modelId, reasoningEffort: codex[2] };
    throw unavailable();
  }
  const exact = identifier(displayedModel);
  if (exact) return { modelId: exact };
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
