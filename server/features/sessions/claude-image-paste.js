import { serverMessages } from "../../lib/i18n/de.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
import { claudeComposerBox, composerProblem } from "./claude-composer.js";

const chip = /\[Image\s+#\s*\d+\]/g;
const imageFile = /\.(?:png|jpe?g|gif|webp)$/i;

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

// A path Claude 2.1.280 turns into a chip: absolute, an image extension, and
// optionally wrapped in one pair of single or double quotes.
function imagePath(line) {
  const trimmed = line.trim();
  const file = /^(['"])(.*)\1$/.exec(trimmed)?.[2] ?? trimmed;
  return path.isAbsolute(file) && imageFile.test(file) ? file : null;
}

const isFile = (file) =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

/**
 * Splits a chat message into the local image paths Claude turns into chips and
 * the remaining text, or null when it attaches no image. Claude Code 2.1.280
 * places the chips of a paste before its remaining lines, so pasting the paths
 * first and the text afterwards keeps chips and text in the same order. Unlike a
 * single paste, which also silently drops blank lines and path-like lines that
 * are not chips (missing absolute paths, ~/ and relative image paths), the text
 * paste keeps those lines as the user wrote them.
 */
export async function claudeImageMessage(text) {
  const images = [];
  const rest = [];
  for (const line of text.split("\n")) {
    const file = imagePath(line);
    if (file && (await isFile(file))) images.push(file);
    else rest.push(line);
  }
  if (!images.length) return null;
  const remaining = rest.join("\n");
  return { images, text: remaining.trim() ? remaining : "" };
}

/** Whether the message names an absolute image file that no longer exists. */
export async function missingClaudeImages(text) {
  for (const line of text.split("\n")) {
    const file = imagePath(line);
    if (file && !(await isFile(file))) return true;
  }
  return false;
}

// Claude numbers chips per session, so only their position and count are stable.
const chipless = (value) => value.replace(chip, "[Image #]");

/**
 * Whether a single-row readable Claude draft is exactly the message's chips
 * followed by `text` (chips only by default). Wrapped, collapsed or scrolled
 * drafts are never matched, like plain text drafts.
 */
export function claudeImageDraft(composer, message, { text = "" } = {}) {
  if (composer?.state !== "text" || !message?.images.length) return false;
  const expected = message.images.map(() => "[Image #1]").join(" ") + text;
  return chipless(composer.text) === chipless(expected);
}

/** Claude asynchronously turns pasted local image paths into image chips. */
export async function waitForClaudeImages(
  manager,
  session,
  expected,
  { timeoutMs = 10000 } = {},
) {
  if (!Number.isInteger(expected) || expected < 0)
    throw problem(serverMessages.sessionInput.imagesUninspectable, 409);
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
  // Pasted but not submitted: the images may still be loading. Never add the
  // text or submit a message without proven images.
  throw composerProblem("CHAT_IMAGES_UNCONFIRMED");
}
