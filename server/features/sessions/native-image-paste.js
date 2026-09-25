import { setTimeout as sleep } from "node:timers/promises";
import { nativePromptState } from "./native-prompt.js";

const chip = /\[Image\s+#?\s*\d+\]/g;

export function nativeComposerImages(tool, raw, pane) {
  const state = nativePromptState(tool, { raw, pane });
  return state.rows ? [...state.rows.join("\n").matchAll(chip)].length : null;
}

/** Full native prompt only; collapsed text and missing chips cannot authorize Enter. */
export function nativeImageDraft(tool, fresh, message, { text = "" } = {}) {
  if (!message?.images.length) return false;
  const state = nativePromptState(tool, fresh);
  if (state.state !== "draft") return false;
  const content = state.rows.join("\n");
  if (
    /\[Pasted/.test(content) ||
    [...content.matchAll(chip)].length !== message.images.length
  )
    return false;
  // Chips are separate native attachment tokens; their separator is not user text.
  return content.replace(chip, "").trim() === text.trim();
}

export async function waitForNativeImages(
  manager,
  session,
  expected,
  { timeoutMs = 10000, exact = true } = {},
) {
  const target = `${manager.target(session.id)}:0.0`;
  const deadline = performance.now() + timeoutMs;
  do {
    const captured = await manager.tmux([
      "display-message",
      "-p",
      "-t",
      target,
      "#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}",
      ";",
      "capture-pane",
      "-e",
      "-p",
      "-t",
      target,
    ]);
    const newline = captured.indexOf("\n");
    const [cursorX, cursorY, width, height] = captured
      .slice(0, newline)
      .split("|")
      .map(Number);
    const fresh = {
      raw: captured.slice(newline + 1),
      pane: { cursorX, cursorY, width, height },
    };
    const state = nativePromptState(session.tool, fresh);
    if (state.state === "dialog") return "dialog";
    const count = nativeComposerImages(session.tool, fresh.raw, fresh.pane);
    if (count !== null && (exact ? count === expected : count >= expected)) return true;
    await sleep(50);
  } while (performance.now() < deadline);
  return false;
}
