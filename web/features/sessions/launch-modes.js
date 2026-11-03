import { cliDefinition, isCodingCli } from "../../../server/features/clis/catalog.js";

// Launch modes the dialog offers per CLI, in display order after "default"; the
// catalog holds them (server/features/clis/<id>/definition.js).
const storageKey = "agentpier.launch-modes";

/** Non-default modes the CLI accepts; empty for Shell and unknown tools. */
export function launchModes(tool) {
  return isCodingCli(tool)
    ? Object.keys(cliDefinition(tool).launchModes).filter((mode) => mode !== "default")
    : [];
}

function valid(tool, mode) {
  return mode === "default" || launchModes(tool).includes(mode);
}

function readRemembered() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

/** Today's built-in preselection, independent of anything remembered. */
export function defaultLaunchMode(tool) {
  return isCodingCli(tool) ? cliDefinition(tool).defaultLaunchMode : "default";
}

/**
 * The mode the owner last launched with for this CLI, or null when nothing
 * usable is stored (unknown id, another tool's mode, blocked storage).
 */
export function rememberedLaunchMode(tool) {
  const saved = readRemembered();
  const mode = Object.hasOwn(saved, tool) ? saved[tool] : undefined;
  return typeof mode === "string" && valid(tool, mode) ? mode : null;
}

/** Modes that drop the CLI's approval prompts; the dialog marks them as a warning. */
export function unattendedLaunchMode(tool, mode) {
  return isCodingCli(tool) && cliDefinition(tool).unattendedModes.includes(mode);
}

/** Called after a successful launch, so a rejected attempt is not remembered. */
export function rememberLaunchMode(tool, mode) {
  if (!isCodingCli(tool) || !valid(tool, mode)) return;
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ...readRemembered(), [tool]: mode }),
    );
  } catch {
    // A restricted browser still launches; it just keeps the defaults next time.
  }
}
