import { tmuxServerGone } from "./tmux-server-identity.js";
import {
  ALTERNATE_SESSION_PREFIX,
  parseSessionLines,
  pickSessionNames,
} from "./tmux-naming.js";
import { validId } from "./session-validation.js";

const MISSING = /can't find (session|window|pane)/i;

/** Logs an unexpected tmux failure by its first line only; tmux errors carry no input. */
export function diagnostic(context, error) {
  const detail = String(error?.code || error?.message || "unknown error")
    .split("\n")[0]
    .slice(0, 200);
  console.error(`AgentPier ${context}: ${detail}`);
}

/** Records the ids whose session runs under the other name form (see tmux-naming.js). */
export async function scanSessionNames(manager) {
  let output;
  try {
    output = await manager.tmux(["list-sessions", "-F", "#{session_name}|#{pane_dead}"]);
  } catch (error) {
    // No server: nothing to adopt. Anything else is worth a trace.
    if (!tmuxServerGone(error.message))
      diagnostic("could not list tmux sessions at startup", error);
    return;
  }
  for (const [id, entry] of pickSessionNames(parseSessionLines(output)))
    if (entry.alternate) manager.alternateSessions.add(id);
}

/** The state of `tuiui-<id>`: "live", "dead", "missing" or "unknown" (probe failed). */
export async function alternatePaneState(manager, id) {
  try {
    // display-message would answer for a missing target too; list-panes fails instead.
    const output = await manager.tmux([
      "list-panes",
      "-t",
      `=${ALTERNATE_SESSION_PREFIX}${validId(id)}:`,
      "-F",
      "#{pane_dead}",
    ]);
    const state = output.split("\n")[0].trim();
    if (state === "1") return "dead";
    if (state === "0") return "live";
    throw new Error("unexpected tmux pane state");
  } catch (error) {
    if (MISSING.test(error.message) || tmuxServerGone(error.message)) return "missing";
    diagnostic("could not check a session under its other name", error);
    return "unknown";
  }
}
