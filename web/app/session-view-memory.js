import { defaultSessionMode } from "./routes.js";

const storageKey = "agentpier.session-views.v1";
const modes = new Set(["reader", "terminal", "files"]);
const identity = (session) =>
  JSON.stringify([session.id, session.createdAt || "", session.tool]);
const coding = (session) => session.tool !== "shell" && session.purpose !== "login";

/** Tab-local navigation preferences, with an in-memory fallback when storage is blocked. */
export class SessionViewMemory {
  constructor(storage) {
    this.storage = storage;
    this.entries = new Map();
    this.preferred = null;
    try {
      const saved = JSON.parse(storage()?.getItem(storageKey) || "null");
      if (["reader", "terminal"].includes(saved?.preferred))
        this.preferred = saved.preferred;
      if (Array.isArray(saved?.entries))
        for (const entry of saved.entries.slice(-200))
          if (Array.isArray(entry) && typeof entry[0] === "string" && modes.has(entry[1]))
            this.entries.set(entry[0], entry[1]);
    } catch {
      // Private browsing or corrupt preference data must not prevent navigation.
    }
  }
  remember(session, mode) {
    if (!modes.has(mode) || (!coding(session) && mode === "reader")) return;
    const key = identity(session);
    const preferred = coding(session) && mode !== "files" ? mode : this.preferred;
    if (this.entries.get(key) === mode && preferred === this.preferred) return;
    this.entries.delete(key);
    this.entries.set(key, mode);
    this.preferred = preferred;
    while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value);
    try {
      this.storage()?.setItem(
        storageKey,
        JSON.stringify({
          preferred: this.preferred,
          entries: [...this.entries],
        }),
      );
    } catch {
      // The current tab can still remember views in memory.
    }
  }
  mode(session, mobile) {
    const saved = this.entries.get(identity(session));
    if (saved && (saved !== "reader" || coding(session))) return saved;
    return (coding(session) && this.preferred) || defaultSessionMode(session, mobile);
  }
}
