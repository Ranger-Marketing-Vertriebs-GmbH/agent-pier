import { setTimeout as sleep } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";

const plain = (line) => (line || "").replace(/\x1b\[[0-9;:]*m/g, "");
// Footers of Claude's native modal UI: permission prompts, rewind, pickers.
const dialogFooter =
  /\b(?:Esc to (?:cancel|go back|close|exit)|Enter to (?:confirm|continue|select|submit|set)|Tab to amend)\b|Do you want to (?:proceed|make this edit|create)/i;
// Menu panels keep their ▔ top border visible; a selected numbered option counts
// only where the cursor sits or with a further option below it, never as the
// transcript echo of a message that starts with "1.".
const menuBorder = /^▔{8}/;
const selectedOption = /^ *❯ \d+\. /;
const otherOption = /^ *(?:[↓↑] )?\d+\. /;
function dialogBody(rows, pane) {
  return rows.some(
    (row, index) =>
      menuBorder.test(row) ||
      (selectedOption.test(row) &&
        (index === pane?.cursorY ||
          rows.slice(index + 1, index + 5).some((next) => otherOption.test(next)))),
  );
}
// A placeholder behind the reverse-video cursor cell. tmux may wrap the reset
// code into the next row or truncate the text with "…" in narrow panes, and
// NO_COLOR/FORCE_COLOR=0 drops the dim attribute.
const placeholderRow =
  /^(?:\x1b\[[0-9;]*m)*❯[ \u00a0]\x1b\[7m(?:\x1b\[39m)?([^\x1b])(\x1b\[0;2m|\x1b\[0m)([^\x1b]*)(?:\x1b\[0m)?$/;
// With Claude's native terminal cursor (tengu_native_cursor rollout or
// CLAUDE_CODE_NATIVE_CURSOR) no cursor cell is drawn: the placeholder is only dim.
// Typed text is never dim, so a dim row at the start cell is always a placeholder.
const nativePlaceholderRow =
  /^(?:\x1b\[[0-9;]*m)*❯[ \u00a0]\x1b\[2m(?:\x1b\[39m)?([^\x1b]+)(?:\x1b\[0m)?$/;
const queuedPlaceholder = "Press up to edit queued messages";
const queuedText = (text) =>
  text === queuedPlaceholder ||
  (text.endsWith("…") &&
    text.length > 2 &&
    queuedPlaceholder.startsWith(text.slice(0, -1)));
// Footer hints Claude Code 2.1.280 renders only while its prompt is empty; a
// draft reduces the footer to the permission mode.
const emptyPromptHints = ["esc to interrupt", "? for shortcuts"];

/**
 * NO_COLOR/FORCE_COLOR=0: Claude emits no styling besides its reverse-video
 * cursor cell (none at all with the native cursor). Colored panes always style
 * their borders.
 */
export function colorlessScreen(text) {
  return !/\x1b\[(?!0?m|7m)[0-9;:]*m/.test(text || "");
}

/**
 * The footer below the prompt box shows a hint that only an empty prompt has.
 * Hints are joined by " · "; a right-aligned notice may follow after a gap.
 */
function emptyPromptFooter(footer) {
  return plain(footer)
    .split(/\s·\s|\s{2,}/)
    .map((hint) => hint.trim())
    .some(
      (hint) =>
        emptyPromptHints.includes(hint) ||
        // A truncated hint must still name itself ("esc to…" does not).
        (hint.endsWith("…") &&
          hint.length > 8 &&
          emptyPromptHints.some((full) => full.startsWith(hint.slice(0, -1)))),
    );
}

/** Text of a one-row prompt shaped like a placeholder at the cursor's start cell. */
function placeholderShape(line, pane, colorless) {
  if (pane?.cursorX !== 2) return null;
  const native = nativePlaceholderRow.exec(line || "");
  if (native) return { text: native[1].trimEnd(), dim: true };
  const match = placeholderRow.exec(line || "");
  if (match)
    return { text: (match[1] + match[3]).trimEnd(), dim: match[2] === "\x1b[0;2m" };
  // Native cursor without color: a bare row.
  const bare = colorless && /^❯[  ]([^\x1b]+)$/.exec(line || "");
  return bare ? { text: bare[1].trimEnd(), dim: false } : null;
}

/**
 * Claude's empty prompt showing a placeholder, at the cursor's start cell.
 * `queued` accepts only the (possibly truncated) queued-messages placeholder;
 * `screen` (the whole capture) decides whether the pane is colorless.
 *
 * A colored Claude always dims its placeholder, so undimmed text is typed.
 * Without color a draft whose cursor sits on its first character looks exactly
 * like a placeholder or prompt suggestion. It then counts only while `footer`
 * (the row below the prompt box) shows a hint Claude renders for an empty
 * prompt alone, so a typed "Press up to edit queued messages" is never taken
 * for an empty prompt. Without that hint (narrow panes cut it to "…") the row
 * is a `claudeAmbiguousPlaceholder`.
 */
export function claudePlaceholder(
  line,
  pane,
  { queued = false, footer = "", screen = line } = {},
) {
  const colorless = colorlessScreen(screen);
  const shape = placeholderShape(line, pane, colorless);
  if (!shape) return false;
  if (!colorless) return shape.dim && (queued ? queuedText(shape.text) : !!shape.text);
  return (queued ? queuedText(shape.text) : !!shape.text) && emptyPromptFooter(footer);
}

/**
 * A colorless row that is either a placeholder or a draft whose cursor sits on
 * its first character. Only the prompt's reaction to editing keys tells them
 * apart: a draft moves its cursor on ctrl+e, a placeholder stays inert.
 */
export function claudeAmbiguousPlaceholder(line, pane, screen = line) {
  const colorless = colorlessScreen(screen);
  return colorless && Boolean(placeholderShape(line, pane, colorless)?.text);
}

export function composerProblem(code) {
  return Object.assign(problem(copy.reasons[code], 409), { code });
}

/**
 * The ruled Claude prompt box around the cursor, or null for any other screen.
 * In a short pane a multi-row draft pushes the bottom border and footer below
 * the last visible row; such a box is open (`clipped`) but still the prompt.
 */
export function claudeComposerBox(raw, pane = {}) {
  if (typeof raw !== "string" || !Number.isInteger(pane.cursorY) || !pane.width)
    return null;
  const all = raw.split("\n");
  const lines = Number.isInteger(pane.height) ? all.slice(0, pane.height) : all;
  const border = "─".repeat(pane.width);
  const row = pane.cursorY;
  if (row < 1 || row >= lines.length || plain(lines[row]) === border) return null;
  let top = row - 1;
  while (top >= 0 && plain(lines[top]) !== border) top--;
  let bottom = row + 1;
  while (bottom < lines.length && plain(lines[bottom]) !== border) bottom++;
  if (top < 0) return null;
  const rows = lines.slice(top + 1, bottom).map(plain);
  // Normal prompt or bash mode; every further row is an indented continuation.
  if (
    !/^[❯!][ \u00a0]/.test(rows[0]) ||
    rows.slice(1).some((value) => !value.startsWith("  "))
  )
    return null;
  return {
    top,
    bottom,
    rows,
    first: lines[top + 1],
    raw: lines.slice(top + 1, bottom),
    // The row below the bottom border: Claude's footer hints.
    footer: lines[bottom + 1],
    clipped: bottom >= lines.length,
  };
}

/**
 * Claude-specific readiness: empty/text (exactly readable), draft (a prompt box
 * with unreadable content such as multiple lines or chips), dialog or unknown.
 */
export function claudeComposerState(raw, pane, composer) {
  if (composer?.state === "empty" || composer?.state === "text") return composer;
  const box = claudeComposerBox(raw, pane);
  if (box) {
    const single =
      box.rows.length === 1 &&
      pane.cursorX === 2 &&
      pane.cursorY === box.top + 1 &&
      !box.clipped;
    if (single && claudePlaceholder(box.first, pane, { footer: box.footer, screen: raw }))
      return { state: "empty", text: "" };
    // Without color: a placeholder or a draft with its cursor at the start.
    if (single && claudeAmbiguousPlaceholder(box.first, pane, raw))
      return { state: "draft", text: null, placeholder: true };
    return { state: "draft", text: null };
  }
  const screen = typeof raw === "string" ? raw.split("\n").map(plain) : [];
  const visible = screen.slice(0, pane?.height || screen.length);
  // A short pane can scroll a menu's footer away: its ▔ panel border or a
  // selected numbered option still identify it. Enter must never reach it.
  if (
    visible.slice(-20).some((line) => dialogFooter.test(line)) ||
    dialogBody(visible, pane)
  )
    return { state: "dialog", text: null };
  return { state: "unknown", text: null };
}

export function assertClaudeComposer(state, allowed) {
  if (allowed.includes(state.state)) return;
  throw composerProblem(
    state.state === "dialog"
      ? "CHAT_COMPOSER_DIALOG"
      : ["text", "draft"].includes(state.state)
        ? "CHAT_COMPOSER_NOT_CLEARED"
        : "CHAT_COMPOSER_UNAVAILABLE",
  );
}

// Progress means the prompt box or cursor changed, never a spinner or timer.
const view = (fresh) =>
  JSON.stringify([
    claudeComposerBox(fresh.raw, fresh.pane)?.raw ?? fresh.raw,
    fresh.pane.cursorX,
    fresh.pane.cursorY,
  ]);

async function changed(snapshot, before, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let fresh;
  do {
    await sleep(25);
    fresh = await snapshot();
    if (view(fresh) !== view(before)) {
      // Let Ink finish the frame before judging it.
      await sleep(25);
      return snapshot();
    }
  } while (performance.now() < deadline);
  return fresh;
}

/**
 * Replace an existing Claude draft: end of line, kill to line start, then join
 * the previous or next line. Validated against Claude Code 2.1.280 for single,
 * wrapped, multi-line, pasted-text and image-chip drafts; see
 * docs/direct-chat-tui-validation.md. Never uses Escape or Ctrl-C, which
 * interrupt a running turn or open the rewind selector.
 */
export async function clearClaudeComposer(
  manager,
  session,
  initial,
  snapshot,
  { rounds = 60, settleMs = 750, timeoutMs = 5000, maxKeys = 150 } = {},
) {
  const target = `${manager.target(session.id)}:0.0`;
  // The session lock is held meanwhile: bound the time and keystrokes spent.
  const deadline = performance.now() + timeoutMs;
  let keyCount = 0;
  let fresh = initial;
  const state = () => claudeComposerState(fresh.raw, fresh.pane, fresh.composer);
  for (let round = 0; round < rounds; round++) {
    if (state().state === "empty") return fresh;
    assertClaudeComposer(state(), ["text", "draft"]);
    let progressed = false;
    for (const keys of [["C-e", "C-u"], ["BSpace"], ["DC"]]) {
      if (performance.now() >= deadline || keyCount + keys.length > maxKeys)
        throw composerProblem("CHAT_COMPOSER_NOT_CLEARED");
      keyCount += keys.length;
      const before = fresh;
      await manager.tmux(["send-keys", "-t", target, ...keys]);
      fresh = await changed(snapshot, before, settleMs);
      const moved = view(fresh) !== view(before);
      progressed ||= moved;
      if (state().state === "empty") return fresh;
      assertClaudeComposer(state(), ["text", "draft"]);
      // Joining with the previous line worked; forward delete is only needed
      // when the cursor sits on the first line.
      if (moved && keys[0] === "BSpace") break;
    }
    // Editing keys move a draft's cursor; a colorless placeholder stays inert.
    if (!progressed) {
      if (state().placeholder) return fresh;
      break;
    }
  }
  throw composerProblem("CHAT_COMPOSER_NOT_CLEARED");
}

/** After Enter, Claude empties its prompt (or shows the queued-message placeholder). */
export async function confirmClaudeSubmit(
  snapshot,
  { slash = false, unreadable = false, timeoutMs = 5000 } = {},
) {
  const deadline = performance.now() + timeoutMs;
  do {
    const fresh = await snapshot();
    const { state, placeholder } = claudeComposerState(
      fresh.raw,
      fresh.pane,
      fresh.composer,
    );
    // A native slash command may replace the prompt with its own picker; an
    // unreadable prompt cannot show that it emptied. A placeholder-shaped
    // colorless row after Enter is no longer the submitted text, which would
    // end at the cursor.
    if (
      state === "empty" ||
      placeholder ||
      (slash && ["dialog", "unknown"].includes(state)) ||
      (unreadable && state === "unknown")
    )
      return;
    await sleep(50);
  } while (performance.now() < deadline);
  throw composerProblem("CHAT_SUBMIT_UNCONFIRMED");
}
