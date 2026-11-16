import { TaskControl } from "../features/chat/task-control.js";
import { TaskReads } from "../features/chat/task-reads.js";
import { TaskStopStore } from "../features/chat/task-stop-store.js";
import { ClaudeModCommands } from "../features/claude-mod/claude-mod-commands.js";
import { claudeTaskDriver } from "../features/claude-mod/claude-task-driver.js";
import { NativeCommands } from "../features/requests/native-commands.js";
import { openCodeTaskDriver } from "../features/chat/opencode-task-driver.js";
import { CodexTaskState } from "../features/chat/codex-task-state.js";
import { codexTaskDriver } from "../features/chat/codex-task-driver.js";

// Claude Code's host aborts a mod's `$.http.fetch` after 30 s (measured on 2.1.325);
// a command poll is answered well before.
const CLAUDE_COMMAND_HOLD_MS = 25000;
const CLAUDE_TOOL = "claude";
const OPENCODE_TOOL = "opencode";
const CODEX_TOOL = "codex";

/**
 * What the chat's task sheet reads and controls, as one shared set: the reads of
 * transcripts and shell output, the stop control and the stops it persisted. The
 * control's overlay is installed on the chat store, so every chat read carries the
 * stop flags and notes. CLI drivers register on `taskControl` by tool id.
 * `claudeCommands` is the bridge mod's command channel (the request broker serves
 * its long-poll); `useClaudeMod(mod)` hands it the ClaudeModBridge, which routes the
 * mod's results and hello to it, and registers the Claude Code driver.
 * `nativeCommands` sends commands over the native request channel (the broker serves
 * it); the OpenCode driver stops subagents through it, the Codex driver subagents
 * and background terminals, which `codexTasks` (the proxy's reports, live only) lists.
 */
export function createTaskServices({ config, sessions, chat, history, chatEvents }) {
  const taskReads = new TaskReads({ sessions, chat, history });
  const taskControl = new TaskControl({
    sessions,
    chat,
    reads: taskReads,
    stops: new TaskStopStore({ dataDir: config.dataDir }),
    onChange: (id) => chatEvents.publish(id, "snapshot-changed"),
  });
  chat.overlay = (session, snapshot) => taskControl.overlay(session, snapshot);
  const claudeCommands = new ClaudeModCommands({
    holdMs: CLAUDE_COMMAND_HOLD_MS,
    onChange: (id) => taskControl.channelChanged(id),
  });
  const useClaudeMod = (mod) => {
    mod.commands = claudeCommands;
    taskControl.register(
      CLAUDE_TOOL,
      claudeTaskDriver({ commands: claudeCommands, mod }),
    );
  };
  const codexTasks = new CodexTaskState({
    onChange: (id) => taskControl.channelChanged(id),
  });
  const nativeCommands = new NativeCommands({
    onChange: (id) => taskControl.channelChanged(id),
    // What a Codex launch's proxy reports it can stop; its channel's end forgets it.
    onTasks: (id, push) => (push ? codexTasks.report(id, push) : codexTasks.forget(id)),
  });
  taskControl.register(OPENCODE_TOOL, openCodeTaskDriver({ commands: nativeCommands }));
  taskControl.register(
    CODEX_TOOL,
    codexTaskDriver({ commands: nativeCommands, state: codexTasks }),
  );
  // The request broker's options for both command channels it serves.
  const brokerCommands = { modCommands: claudeCommands, commands: nativeCommands };
  return {
    taskReads,
    taskControl,
    claudeCommands,
    nativeCommands,
    brokerCommands,
    useClaudeMod,
  };
}
