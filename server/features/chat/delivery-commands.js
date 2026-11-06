import { setTimeout as sleep } from "node:timers/promises";
import { claudeComposerState } from "../sessions/claude-composer.js";
import { nativePromptState } from "../sessions/native-prompt.js";
import { cliDefinition, isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

/**
 * True for `!…` (bash mode) and the driver's local commands: neither sends a
 * native submit event. Custom skills (`/my-skill`) do and are not listed.
 */
export function unconfirmedCommand(tool, text) {
  const names = isCodingCli(tool) ? cliDriver(tool).tui.localCommands : undefined;
  if (!names || typeof text !== "string") return false;
  if (text.startsWith("!")) return true;
  const name = /^\/([a-z][a-z0-9_:-]*)(?: +[^\r\n]*)?$/i.exec(text)?.[1];
  return Boolean(name && names.includes(name.toLowerCase()));
}

/** Whether the prompt box in `fresh` is provably empty, with no dialog open. */
function promptCleared(tool, fresh) {
  if (cliDriver(tool).tui.blockingScreen?.(fresh.raw, {})) return false;
  const state = cliDefinition(tool).capabilities.imagePaste
    ? claudeComposerState(fresh.raw, fresh.pane, fresh.composer)
    : nativePromptState(tool, fresh);
  return state.state === "empty";
}

/**
 * After Enter: poll the screen until the prompt box is empty with no dialog
 * open. False when it never shows within `timeoutMs` or cannot be read; the
 * command then stays handed-off and the owner is asked.
 */
export async function commandCleared(
  tool,
  screen,
  { timeoutMs = 2000, intervalMs = 100 } = {},
) {
  const deadline = performance.now() + timeoutMs;
  do {
    try {
      if (promptCleared(tool, await screen())) return true;
    } catch {
      /* A blocking screen or unreadable pane is no confirmation. */
    }
    await sleep(intervalMs);
  } while (performance.now() < deadline);
  return false;
}
