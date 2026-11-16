import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const MAX_NOTES = 20;
const LABEL_LENGTH = 80;
const FINISHED = new Set(["completed", "failed"]);
const KINDS = [
  ["subagents", "agent"],
  ["shells", "shell"],
];
const fail = (key, status, code, reason) =>
  Object.assign(problem(serverMessages.chat[key], status), {
    code,
    ...(reason === undefined ? {} : { reason }),
  });

/** The name a note gives a task: one line, no quotes, cut short. */
function label(entry) {
  return String(entry.name || entry.description || entry.command || "")
    .replace(/[\p{Cc}]/gu, " ")
    .replaceAll('"', "'")
    .slice(0, LABEL_LENGTH);
}
const noteText = (entry) =>
  `[AgentPier: the user stopped background task "${label(entry)}" (${entry.id}).]`;

/**
 * Stopping the background tasks a session lists. A CLI driver, registered per tool,
 * says whether its command channel is up, whether it can stop a given task and does
 * the stop: { connected(session), canStop(session, task), stop(session, task) } with
 * task { kind: "agent" | "shell", id, entry }; stop resolves { ok: true } or
 * { ok: false, reason, gone? }.
 */
export class TaskControl {
  constructor({ sessions, chat, reads, stops, onChange, timeoutMs = 10000 }) {
    this.sessions = sessions;
    this.chat = chat;
    this.reads = reads;
    this.stops = stops;
    this.onChange = onChange;
    this.timeoutMs = timeoutMs;
    this.drivers = new Map();
    this.inflight = new Map();
    this.notes = new Map();
  }
  register(tool, driver) {
    this.drivers.set(tool, driver);
  }
  /** A command channel came or went: the browser re-reads which tasks it may stop. */
  channelChanged(sessionId) {
    this.onChange?.(sessionId);
  }

  /** The snapshot with what only this service knows: stops, stop flags and notes. */
  overlay(session, snapshot) {
    const observability = snapshot?.observability;
    if (!observability) return snapshot;
    const driver = this.drivers.get(session.tool);
    const live = session.status === "running" && !observability.stale;
    const tasks = ([key, kind]) => [
      key,
      (observability[key] || []).map((entry) => {
        const stopped = !FINISHED.has(entry.status) && this.stops.has(session, entry.id);
        const status = stopped ? "stopped" : entry.status;
        const task = { kind, id: entry.id, entry: { ...entry, status } };
        return {
          ...entry,
          status,
          canStop: Boolean(
            live &&
            status === "running" &&
            driver?.connected(session) &&
            driver.canStop(session, task),
          ),
          ...this.reads.flags(session, kind, entry),
        };
      }),
    ];
    return {
      ...snapshot,
      observability: {
        ...observability,
        ...Object.fromEntries(KINDS.map(tasks)),
        stopNotes: (this.notes.get(session.id) || []).map(({ id, text }) => ({
          id,
          text,
        })),
      },
    };
  }

  async find(sessionId, taskId) {
    const observability = (await this.chat.read(sessionId))?.observability;
    for (const [key, kind] of KINDS) {
      const entry = observability?.[key]?.find((item) => item.id === taskId);
      if (entry) return { kind, id: taskId, entry };
    }
    throw problem(serverMessages.chat.taskUnknown, 404);
  }

  async stop(sessionId, taskId) {
    const task = await this.find(sessionId, taskId);
    const session = await this.sessions.get(sessionId);
    const driver = this.drivers.get(session.tool);
    if (!driver) throw fail("taskStopUnsupported", 409, "TASK_STOP_UNSUPPORTED");
    if (task.entry.status !== "running" || session.status !== "running")
      throw fail("taskStopNotRunning", 409, "TASK_STOP_NOT_RUNNING");
    if (!driver.connected(session))
      throw fail("taskStopChannelDown", 503, "TASK_STOP_CHANNEL_DOWN");
    if (!driver.canStop(session, task))
      throw fail("taskStopUnsupported", 409, "TASK_STOP_UNSUPPORTED");
    const key = `${sessionId}\u0000${taskId}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.run(session, driver, task).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  async run(session, driver, task) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
    });
    const attempt = Promise.resolve()
      .then(() => driver.stop(session, task))
      .catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    let result;
    try {
      result = await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (result === "timeout") throw fail("taskStopTimeout", 504, "TASK_STOP_TIMEOUT");
    if (!result?.ok) {
      if (result?.gone) throw fail("taskStopNotRunning", 409, "TASK_STOP_NOT_RUNNING");
      throw fail("taskStopRefused", 409, "TASK_STOP_REFUSED", result?.reason ?? "");
    }
    try {
      this.stops.record(session, { id: task.id, kind: task.kind, at: Date.now() });
    } catch {
      console.error("AgentPier could not save a stopped task.");
    }
    this.addNote(session.id, noteText(task.entry));
    this.onChange?.(session.id);
    return { stopped: true };
  }

  addNote(sessionId, text) {
    const notes = (this.notes.get(sessionId) || []).concat({ id: randomUUID(), text });
    this.notes.set(sessionId, notes.slice(-MAX_NOTES));
  }

  /** Of the note ids a message names, those whose line it really contains. */
  notesCarried(sessionId, ids, text) {
    const notes = this.notes.get(sessionId) || [];
    return ids.filter((id) =>
      notes.some((note) => note.id === id && text.includes(note.text)),
    );
  }

  /** The notes were delivered: forget them. */
  consumeNotes(sessionId, ids) {
    const notes = this.notes.get(sessionId) || [];
    const kept = notes.filter((note) => !ids.includes(note.id));
    if (kept.length === notes.length) return;
    this.notes.set(sessionId, kept);
    this.onChange?.(sessionId);
  }
}
