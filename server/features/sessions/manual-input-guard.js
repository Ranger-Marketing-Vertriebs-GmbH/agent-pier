import { inspectChatComposer } from "./session-chat-input.js";
import { problem } from "../../lib/storage.js";

/** A successful PTY write is not proof that the native editor has rendered it. */
export async function recordManualInput(manager, session, text) {
  if (session.purpose || !["codex", "claude", "opencode"].includes(session.tool)) return;
  const pending = manager.pendingTerminalInput;
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
  const printable = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "");
  if (printable.length) pending.add(session.id);
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
