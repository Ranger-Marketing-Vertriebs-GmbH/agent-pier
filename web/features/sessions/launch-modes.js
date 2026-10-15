// Launch modes the dialog offers per CLI, in display order after "default".
// They mirror LAUNCH_ARGS in server/features/accounts/account-store.js.
const MODES = {
  codex: ["yolo"],
  claude: ["auto", "bypass"],
  opencode: ["auto"],
};
const DEFAULTS = { codex: "yolo", claude: "auto", opencode: "auto" };
const storageKey = "agentpier.launch-modes";

/** Non-default modes the CLI accepts; empty for Shell and unknown tools. */
export function launchModes(tool) {
  return Object.hasOwn(MODES, tool) ? MODES[tool] : [];
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

/**
 * The mode the owner last launched with for this CLI, or today's default when
 * nothing usable is stored (unknown id, another tool's mode, blocked storage).
 */
export function preferredLaunchMode(tool) {
  const saved = readRemembered();
  const mode = Object.hasOwn(saved, tool) ? saved[tool] : undefined;
  if (typeof mode === "string" && valid(tool, mode)) return mode;
  return Object.hasOwn(DEFAULTS, tool) ? DEFAULTS[tool] : "default";
}

/** Called after a successful launch, so a rejected attempt is not remembered. */
export function rememberLaunchMode(tool, mode) {
  if (!Object.hasOwn(MODES, tool) || !valid(tool, mode)) return;
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ...readRemembered(), [tool]: mode }),
    );
  } catch {
    // A restricted browser still launches; it just keeps the defaults next time.
  }
}
