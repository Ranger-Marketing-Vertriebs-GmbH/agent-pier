import { serverMessages } from "../lib/i18n/de.js";
import { problem } from "../lib/storage.js";
import { isCodingCli } from "../features/clis/catalog.js";
import { cliDriver } from "../features/clis/drivers.js";

const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/:\[\]-]{0,299}$/.test(value)
    ? value
    : undefined;
const unavailable = () => problem(serverMessages.sessionReload.modelNotPreservable, 409);

/**
 * Translate only known native chrome; observed IDs independently confirm Claude labels.
 * The CLI's picker driver (`tui.modelPicker.resolveDisplayed`) reads its own display
 * names; a tool without one (OpenCode, the shell) keeps an exact id only.
 */
export function resolveReloadModel({
  tool,
  displayedModel,
  observedModel,
  fallbackModel,
  models,
}) {
  const observed = identifier(observedModel);
  if (!displayedModel) return { modelId: observed || identifier(fallbackModel) };
  const resolveDisplayed = isCodingCli(tool)
    ? cliDriver(tool).tui.modelPicker.resolveDisplayed
    : undefined;
  if (resolveDisplayed) {
    const resolved = resolveDisplayed(displayedModel, {
      observed,
      fallback: fallbackModel,
      models,
      identifier,
      unavailable,
    });
    if (resolved) return resolved;
    throw unavailable();
  }
  const exact = identifier(displayedModel);
  if (exact) return { modelId: exact };
  throw unavailable();
}
