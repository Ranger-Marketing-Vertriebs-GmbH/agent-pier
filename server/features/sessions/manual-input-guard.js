import { inspectChatComposer } from "./session-chat-input.js";
import { problem } from "../../lib/storage.js";

// Track the input stream, not individual WebSocket frames. Only retain protocol
// state (never user text); OSC replies and paste markers can cross frame boundaries.
function inputAction(state, text) {
  let action;
  for (const ch of text) {
    if (state.control === "string") {
      if (ch === "\x07") state.control = null;
      else if (ch === "\x1b") state.control = "string-escape";
      continue;
    }
    if (state.control === "string-escape") {
      state.control = ch === "\\" ? null : "string";
      continue;
    }
    if (state.control === "csi") {
      if (ch >= "@" && ch <= "~") {
        if (ch === "~" && state.parameters === "200") state.pasting = true;
        if (ch === "~" && state.parameters === "201") state.pasting = false;
        state.control = null;
        state.parameters = "";
      } else if (state.parameters.length < 32) state.parameters += ch;
      continue;
    }
    if (state.control === "escape") {
      state.control = null;
      if (ch === "[") {
        state.control = "csi";
        state.parameters = "";
        continue;
      }
      if ("]P^_X".includes(ch)) {
        state.control = "string";
        continue;
      }
      // SS3 keys and character-set selectors have one more protocol byte.
      if ("O()*+-./".includes(ch)) {
        state.control = "single";
        continue;
      }
      // Alt+Enter inserts a newline; it is not an unmodified submit.
      if (ch < " " && ch !== "\x1b") continue;
      // Other ESC + character combinations can be native Alt-key input.
    } else if (state.control === "single") {
      state.control = null;
      continue;
    }
    if (ch === "\x1b") state.control = "escape";
    else if (!state.pasting && /[\r\x03\x15]/.test(ch)) action = "settled";
    else if (ch >= " " && ch !== "\x7f") action = "pending";
  }
  return action;
}

/** A successful PTY write is not proof that the native editor has rendered it. */
export async function recordManualInput(manager, session, text, state = {}) {
  if (session.purpose || !["codex", "claude", "opencode"].includes(session.tool)) return;
  const pending = manager.pendingTerminalInput;
  const action = inputAction(state, text);
  // Explicit submit/cancel/clear ends the unsent input, even if a long draft was
  // collapsed or submitted before the next render. Pasted CRs are never submits.
  if (action === "settled") {
    pending.delete(session.id);
    return;
  }
  if (pending.has(session.id)) {
    const captured = await manager.tmux([
      "display-message",
      "-p",
      "-t",
      `${manager.target(session.id)}:0.0`,
      "#{cursor_x}|#{cursor_y}|#{pane_width}",
      ";",
      "capture-pane",
      "-e",
      "-p",
      "-t",
      `${manager.target(session.id)}:0.0`,
    ]);
    const newline = captured.indexOf("\n");
    const [cursorX, cursorY, width] = captured.slice(0, newline).split("|").map(Number);
    if (
      inspectChatComposer(session.tool, captured.slice(newline + 1), {
        cursorX,
        cursorY,
        width,
      }).state === "text"
    )
      pending.delete(session.id);
  }
  if (action === "pending") pending.add(session.id);
}
export function assertManualInputSettled(manager, id, snapshot) {
  if (!manager.pendingTerminalInput?.has(id)) return;
  if (snapshot.composer.state === "text") {
    // The ordinary composer guard now owns this visible draft, including explicit recovery.
    manager.pendingTerminalInput.delete(id);
    return;
  }
  throw problem("The terminal composer cannot be safely inspected", 409);
}
