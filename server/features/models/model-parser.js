// Each CLI's own reading lives in its driver (`server/features/clis/<id>/tui.js`).
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

const picker = (tool) => cliDriver(tool).tui.modelPicker;

export function unsupportedModelPicker(tool, raw) {
  return isCodingCli(tool) && picker(tool).unsupported(raw);
}
export function parseModelPicker(tool, raw) {
  return isCodingCli(tool) ? picker(tool).parse(raw) : null;
}
export function currentModel(tool, raw) {
  return isCodingCli(tool) ? picker(tool).current(raw) : null;
}
export function modelPromptReady(tool, raw) {
  return isCodingCli(tool) && picker(tool).promptReady(raw);
}
