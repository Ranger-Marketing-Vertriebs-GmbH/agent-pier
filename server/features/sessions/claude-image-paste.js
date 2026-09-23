import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { claudeComposerBox } from "./claude-composer.js";

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

/**
 * Claude asynchronously turns pasted local image paths into image chips. Returns
 * false when the chips cannot be confirmed in time: chat still submits (the path
 * text remains in the message) and reports that images may be missing.
 */
export async function waitForClaudeImagePaste(
  manager,
  session,
  text,
  { timeoutMs = 10000, initialImages = 0 } = {},
) {
  if (session.tool !== "claude") return true;
  const candidates = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line) && /\.(?:png|jpe?g|gif|webp)$/i.test(line));
  if (!candidates.length) return true;
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
  if (!expected) return true;
  // Without a readable baseline only a lower bound can be awaited.
  const baseline = Number.isInteger(initialImages) && initialImages >= 0;
  // Chip-like text the user typed stays literal in the prompt and matches too.
  // Only absolute paths become chips: Claude 2.1.280 leaves ~/ and relative
  // image paths as text.
  expected += (baseline ? initialImages : 0) + [...text.matchAll(chip)].length;
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
    const count =
      newline >= 0 ? claudeComposerImages(captured.slice(newline + 1), pane) : null;
    if (count !== null && (baseline ? count === expected : count >= expected))
      return true;
    await sleep(50);
  } while (performance.now() < deadline);
  // The images may still be loading or scrolled out of a pane too short to show
  // them. Chat must not stay unsent: the caller submits and flags the receipt.
  return false;
}
