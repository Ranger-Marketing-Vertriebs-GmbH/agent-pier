import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory } from "../../lib/storage.js";

const MAX_STOPS = 100;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const valid = (id) => typeof id === "string" && SESSION_ID.test(id);

/**
 * The tasks the owner stopped, per session: `{ id, kind, at }`, kept in
 * `<dataDir>/task-stops/<session id>.json` so a restart still shows them as stopped.
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
          stops = saved.stops
            .filter((stop) => typeof stop?.id === "string")
            .slice(-MAX_STOPS);
      } catch {
        /* No file, or an unreadable one, is no stop. */
      }
      this.cache.set(sessionId, stops);
    }
    return this.cache.get(sessionId);
  }
  has(session, id) {
    return this.load(session.id).some((stop) => stop.id === id);
  }
  record(session, { id, kind, at }) {
    if (!valid(session.id)) throw new Error("Invalid session id");
    const stops = this.load(session.id).filter((stop) => stop.id !== id);
    stops.push({ id, kind, at });
    stops.splice(0, Math.max(0, stops.length - MAX_STOPS));
    this.cache.set(session.id, stops);
    const file = this.file(session.id);
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
