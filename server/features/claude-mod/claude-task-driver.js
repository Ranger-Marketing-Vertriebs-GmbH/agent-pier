import { atLeast } from "../tools/cli-version.js";
import { CLAUDE_TASK_STOP_VERSION } from "./claude-mod-launch.js";

// Longer than the stop service's own 10 s, so a late answer still settles the stop.
const STOP_TIMEOUT_MS = 15000;

/**
 * The Claude Code driver of TaskControl (task-control.js): a stop runs as the
 * bridge mod's `task.stop` command (`$.tool.call` TaskStop inside Claude Code). It
 * needs this launch's mod polling for commands and a hello from Claude Code
 * CLAUDE_TASK_STOP_VERSION or newer. `commands` is ClaudeModCommands, `mod` the
 * ClaudeModBridge that holds the hello's CLI version.
 */
export function claudeTaskDriver({ commands, mod }) {
  return {
    connected: (session) =>
      commands.connected(session.id) &&
      atLeast(mod.cli(session.id), CLAUDE_TASK_STOP_VERSION),
    // Shells of the main loop and subagents alike; TaskStop knows both by id.
    canStop: (session, task) => task.kind === "agent" || task.kind === "shell",
    stop(session, task) {
      // A stopped agent's `killed` notification would start a model turn.
      if (task.kind === "agent") commands.suppress(session.id, task.id);
      return commands.send(
        session.id,
        { name: "task.stop", taskId: task.id },
        { timeoutMs: STOP_TIMEOUT_MS },
      );
    },
  };
}
