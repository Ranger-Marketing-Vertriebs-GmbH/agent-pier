import { setTimeout as sleep } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";

const plain = (line) => (line || "").replace(/\x1b\[[0-9;:]*m/g, "");
// Footers of Claude's native modal UI: permission prompts, rewind, pickers.
const dialogFooter =
  /\b(?:Esc to (?:cancel|go back|close|exit)|Enter to (?:confirm|continue|select|submit|set)|Tab to amend)\b|Do you want to (?:proceed|make this edit|create)/i;
// A placeholder behind the reverse-video cursor cell. tmux may wrap the reset
// code into the next row or truncate the text with "…" in narrow panes, and
// NO_COLOR/FORCE_COLOR=0 drops the dim attribute.
const placeholderRow =
  /^(?:\x1b\[[0-9;]*m)*❯[ \u00a0]\x1b\[7m(?:\x1b\[39m)?([^\x1b])(\x1b\[0;2m|\x1b\[0m)([^\x1b]*)(?:\x1b\[0m)?$/;
const queuedPlaceholder = "Press up to edit queued messages";

/**
 * Claude's empty prompt showing a placeholder, at the cursor's start cell.
 * `queued` accepts only the (possibly truncated) queued-messages placeholder.
 */
export function claudePlaceholder(line, pane, { queued = false } = {}) {
  const match = placeholderRow.exec(line || "");
  if (!match || pane?.cursorX !== 2) return false;
  const text = (match[1] + match[3]).trimEnd();
  // Typed text is never dim; without color only the known placeholder is safe,
  // because a draft with its cursor on the first character looks the same.
  const dim = match[2] === "\x1b[0;2m";
  if (dim && !queued) return text.length > 0;
  // A colored Claude always dims its placeholder; only NO_COLOR drops it.
  if (queued && !dim && /\x1b\[(?:[34]8;|39m)/.test(line)) return false;
  return (
    text === queuedPlaceholder ||
    (text.endsWith("…") &&
      text.length > 2 &&
      queuedPlaceholder.startsWith(text.slice(0, -1)))
  );
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
    if (
      box.rows.length === 1 &&
      pane.cursorX === 2 &&
      pane.cursorY === box.top + 1 &&
      !box.clipped &&
      claudePlaceholder(box.first, pane)
    )
      return { state: "empty", text: "" };
    return { state: "draft", text: null };
  }
  const visible = typeof raw === "string" ? raw.split("\n").slice(-20).map(plain) : [];
  if (visible.some((line) => dialogFooter.test(line)))
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
    if (!progressed) break;
  }
  throw composerProblem("CHAT_COMPOSER_NOT_CLEARED");
}

/** After Enter, Claude empties its prompt (or shows the queued-message placeholder). */
export async function confirmClaudeSubmit(
  snapshot,
  { slash = false, timeoutMs = 5000 } = {},
) {
  const deadline = performance.now() + timeoutMs;
  do {
    const fresh = await snapshot();
    const { state } = claudeComposerState(fresh.raw, fresh.pane, fresh.composer);
    // A native slash command may replace the prompt with its own picker.
    if (state === "empty" || (slash && ["dialog", "unknown"].includes(state))) return;
    await sleep(50);
  } while (performance.now() < deadline);
  throw composerProblem("CHAT_SUBMIT_UNCONFIRMED");
}
