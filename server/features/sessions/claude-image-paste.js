import { serverMessages } from "../../lib/i18n/de.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
import { claudeComposerBox, composerProblem } from "./claude-composer.js";

const chip = /\[Image\s+#\s*\d+\]/g;

/**
 * Image chips in Claude's current prompt box, never image labels in conversation
 * output. Shares the prompt box detection, so a box whose bottom border a short
 * pane clips is still counted. Only visible rows count: a chip scrolled out of
 * view is missing, so the count never exceeds what the screen proves.
 */
export function claudeComposerImages(raw, pane) {
  const box = claudeComposerBox(raw, pane);
  if (!box || !box.rows[0].startsWith("❯")) return null;
  return [...box.rows.join("\n").matchAll(chip)].length;
}

/** Claude asynchronously turns pasted local image paths into image chips. */
export async function waitForClaudeImagePaste(
  manager,
  session,
  text,
  { timeoutMs = 10000, initialImages = 0 } = {},
) {
  if (session.tool !== "claude") return;
  const candidates = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line) && /\.(?:png|jpe?g|gif|webp)$/i.test(line));
  if (!candidates.length) return;
  let expected = 0;
  for (const file of candidates) {
    if (
      await stat(file).then(
        (info) => info.isFile(),
        () => false,
      )
    )
      expected++;
  }
  if (!expected) return;
  if (!Number.isInteger(initialImages) || initialImages < 0)
    throw problem(serverMessages.sessionInput.imagesUninspectable, 409);
  // Chip-like text the user typed stays literal in the prompt and matches too.
  // Only absolute paths become chips: Claude 2.1.280 leaves ~/ and relative
  // image paths as text.
  expected += initialImages + [...text.matchAll(chip)].length;
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
      .slice(0, Math.max(newline, 0))
      .split("|")
      .map(Number);
    const pane = { cursorX, cursorY, width, height };
    if (
      newline >= 0 &&
      claudeComposerImages(captured.slice(newline + 1), pane) === expected
    )
      return;
    await sleep(50);
  } while (performance.now() < deadline);
  // Pasted but not submitted: the images may still be loading or scrolled out of
  // a pane too short to show them. Never submit a message without proven images.
  throw composerProblem("CHAT_IMAGES_UNCONFIRMED");
}
