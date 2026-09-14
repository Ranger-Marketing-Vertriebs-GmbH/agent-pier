import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { problem } from "../../lib/storage.js";

/** Count only the current fenced composer, never image labels in conversation output. */
export function claudeComposerImages(captured) {
  const newline = captured.indexOf("\n");
  const [width, cursor] = captured.slice(0, newline).split("|").map(Number);
  if (newline < 0 || !Number.isInteger(width) || width < 1 || !Number.isInteger(cursor))
    return null;
  const rows = captured
    .slice(newline + 1)
    .replace(/\x1b\[[0-9;:]*m/g, "")
    .split("\n");
  if (cursor < 0 || cursor >= rows.length) return null;
  const border = "─".repeat(width);
  let top = cursor - 1,
    bottom = cursor + 1;
  while (top >= 0 && rows[top] !== border) top--;
  while (bottom < rows.length && rows[bottom] !== border) bottom++;
  if (top < 0 || bottom === rows.length || !rows[top + 1]?.startsWith("❯ ")) return null;
  return [
    ...rows
      .slice(top + 1, bottom)
      .join("\n")
      .matchAll(/\[Image\s+#\s*\d+\]/g),
  ].length;
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
    throw problem("Claude's existing image attachments cannot be inspected", 409);
  expected += initialImages;
  const target = `${manager.target(session.id)}:0.0`;
  const deadline = performance.now() + timeoutMs;
  do {
    const captured = await manager.tmux([
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_width}|#{cursor_y}",
      ";",
      "capture-pane",
      "-e",
      "-p",
      "-t",
      target,
    ]);
    if (claudeComposerImages(captured) === expected) return;
    await sleep(50);
  } while (performance.now() < deadline);
  throw problem("Claude has not finished preparing the pasted images", 409);
}
