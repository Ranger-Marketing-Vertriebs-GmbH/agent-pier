import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { claudeComposerBox, claudeComposerState } from "./claude-composer.js";

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

/**
 * A prompt box holding exactly `count` image chips and nothing else, also when
 * they wrap over several rows. The box must be complete (not clipped) and start
 * with a chip, so no content can hide above or below it.
 */
export function claudeChipsOnly(raw, pane, count) {
  const box = claudeComposerBox(raw, pane);
  if (!box || box.clipped || !/^❯[ \u00a0]\[Image/.test(box.rows[0])) return false;
  const content = box.rows.map((row) => row.slice(2)).join("\n");
  return (
    [...content.matchAll(chip)].length === count && !content.replace(chip, "").trim()
  );
}

/**
 * Claude asynchronously turns pasted local image paths into image chips. Waits
 * for `expected` chips in the prompt box, or at least that many when the chips
 * already there were unreadable (`exact` false). Returns false when the chips
 * cannot be confirmed in time (chat still continues and reports that images
 * may be missing), and "dialog" as soon as a native dialog hides the prompt.
 */
export async function waitForClaudeImages(
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
      .slice(0, Math.max(newline, 0))
      .split("|")
      .map(Number);
    const pane = { cursorX, cursorY, width, height };
    const count =
      newline >= 0 ? claudeComposerImages(captured.slice(newline + 1), pane) : null;
    if (count !== null && (exact ? count === expected : count >= expected)) return true;
    if (
      newline >= 0 &&
      claudeComposerState(captured.slice(newline + 1), pane).state === "dialog"
    )
      return "dialog";
    await sleep(50);
  } while (performance.now() < deadline);
  return false;
}
