import { stripVTControlCharacters } from "node:util";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

/** Only currently visible native warnings; no scrollback, inferred thresholds or history writes. */
export function nativeLimitWarnings(tool, raw, pane) {
  if (
    !isCodingCli(tool) ||
    typeof raw !== "string" ||
    raw.length > 256 * 1024 ||
    !Number.isInteger(pane?.height) ||
    pane.height < 1 ||
    !Number.isInteger(pane?.cursorY) ||
    pane.cursorY < 0 ||
    pane.cursorY >= pane.height
  )
    return [];
  const styled = raw.split("\n").slice(0, pane.height);
  const lines = styled.map(stripVTControlCharacters);
  return [...cliDriver(tool).tui.limitWarning({ raw, pane, styled, lines })].slice(0, 3);
}
