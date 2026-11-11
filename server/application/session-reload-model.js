import { isCodingCli } from "../features/clis/catalog.js";
import { cliDriver } from "../features/clis/drivers.js";

const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/:\[\]-]{0,299}$/.test(value)
    ? value
    : undefined;
const UNRESOLVED = Symbol("unresolved");
const unavailable = () =>
  Object.assign(new Error("unresolved model"), { [UNRESOLVED]: true });

/**
 * The model a reload launches for the name the CLI displays. The CLI's picker driver
 * (`tui.modelPicker.resolveDisplayed`) reads its own display names; a tool without
 * one (OpenCode, the shell) keeps an exact id only.
 *
 * A name that cannot be mapped does not refuse the reload and is never replaced by
 * the model of the last response (the user may have switched since). The reload then
 * launches the model the session was started with (`fallbackModel`), or the CLI's
 * default without one, and returns the name as `unresolved` so the user is told.
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
  let resolved;
  if (resolveDisplayed) {
    try {
      resolved = resolveDisplayed(displayedModel, {
        observed,
        fallback: fallbackModel,
        models,
        identifier,
        unavailable,
      });
    } catch (error) {
      if (!error?.[UNRESOLVED]) throw error;
    }
  } else {
    const exact = identifier(displayedModel);
    if (exact) resolved = { modelId: exact };
  }
  return resolved || { modelId: identifier(fallbackModel), unresolved: displayedModel };
}
