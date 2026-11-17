import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory } from "../../lib/storage.js";

const MAX_STOPS = 100;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const valid = (id) => typeof id === "string" && SESSION_ID.test(id);

/** A saved mark as it is used: only the fields a mark has. */
function mark(value) {
  if (typeof value?.id !== "string") return null;
  return {
    id: value.id,
    kind: value.kind,
    at: Number.isFinite(value.at) ? value.at : 0,
    ...(typeof value.run === "string" ? { run: value.run } : {}),
    ...(value.ended === true ? { ended: true } : {}),
  };
}

/**
 * Marks of tasks per session, kept in `<dataDir>/task-stops/<session id>.json` so a
 * restart still shows them: `{ id, kind, at, run? }` for a task the owner stopped
 * (`run`: the run it stopped, where the CLI names one) and `{ id, kind, at, ended }`
 * for a task a stop found already ended although the chat still listed it running.
 * Not in the session's native-sessions folder: a sandboxed CLI may write there and
 * could otherwise forge or erase stops of its own tasks.
 */
export class TaskStopStore {
  constructor({ dataDir }) {
    this.directory = path.join(dataDir, "task-stops");
    this.cache = new Map();
  }
  file(sessionId) {
    return path.join(this.directory, `${sessionId}.json`);
  }
  load(sessionId) {
    if (!valid(sessionId)) return [];
    if (!this.cache.has(sessionId)) {
      let stops = [];
      try {
        const saved = JSON.parse(fs.readFileSync(this.file(sessionId), "utf8"));
        if (saved?.version === 1 && Array.isArray(saved.stops))
          stops = saved.stops.map(mark).filter(Boolean).slice(-MAX_STOPS);
      } catch {
        /* No file, or an unreadable one, is no stop. */
      }
      this.cache.set(sessionId, stops);
    }
    return this.cache.get(sessionId);
  }
  has(session, id) {
    return this.get(session, id) !== null;
  }
  /** The mark of task `id`, or null. */
  get(session, id) {
    return this.load(session.id).find((stop) => stop.id === id) ?? null;
  }
  record(session, value) {
    if (!valid(session.id)) throw new Error("Invalid session id");
    const stops = this.load(session.id).filter((stop) => stop.id !== value.id);
    stops.push(mark(value));
    stops.splice(0, Math.max(0, stops.length - MAX_STOPS));
    this.save(session.id, stops);
  }
  /** The task runs again: its mark goes. */
  remove(session, id) {
    const stops = this.load(session.id);
    if (!stops.some((stop) => stop.id === id)) return;
    this.save(
      session.id,
      stops.filter((stop) => stop.id !== id),
    );
  }
  save(sessionId, stops) {
    this.cache.set(sessionId, stops);
    const file = this.file(sessionId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      privateDirectory(this.directory);
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, stops }) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  forget(sessionId) {
    if (!valid(sessionId)) return;
    this.cache.delete(sessionId);
    fs.rmSync(this.file(sessionId), { force: true });
  }
}
