import { TaskControl } from "../features/chat/task-control.js";
import { TaskReads } from "../features/chat/task-reads.js";
import { TaskStopStore } from "../features/chat/task-stop-store.js";

/**
 * What the chat's task sheet reads and controls, as one shared set: the reads of
 * transcripts and shell output, the stop control and the stops it persisted. The
 * control's overlay is installed on the chat store, so every chat read carries the
 * stop flags and notes. CLI drivers register on `taskControl` by tool id.
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
  return { taskReads, taskControl };
}
