import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sessionFolder } from "../sessions/session-own-folder.js";

const MAX_STOPS = 100;

/**
 * The tasks the owner stopped, per session: `{ id, kind, at }`, kept next to the
 * session's native files so a restart still shows them as stopped. Not every CLI
 * reports a stop itself.
 */
export class TaskStopStore {
  constructor({ dataDir }) {
    this.root = path.join(dataDir, "native-sessions");
    this.cache = new Map();
  }
  file(sessionId) {
    return path.join(sessionFolder(this.root, sessionId), `${sessionId}.task-stops.json`);
  }
  load(sessionId) {
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
    const stops = this.load(session.id).filter((stop) => stop.id !== id);
    stops.push({ id, kind, at });
    stops.splice(0, Math.max(0, stops.length - MAX_STOPS));
    this.cache.set(session.id, stops);
    const file = this.file(session.id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, stops }) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  forget(sessionId) {
    this.cache.delete(sessionId);
    fs.rmSync(this.file(sessionId), { force: true });
  }
}
