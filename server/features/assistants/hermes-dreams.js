import { backupHermesMemory, localTime } from "./dreaming-backups.js";
import { dreamOnce } from "./hermes-dream.js";
import { dreamChatBudget, dreamChats } from "./hermes-dream-chats.js";
import { memoryEnabled } from "./native-capabilities.js";
import { NativeMemory } from "./native-memory.js";
import { hostReady, runtimeFor, runtimeIdOf } from "./runtimes/runtime-for.js";

/*
 * Hermes's nightly dream, once a night per agent at the owner's dreaming hour
 * (DreamingSettings): every non-archived Hermes agent with memory, users' own agents
 * and temporary members included, dreams over its chats since its last applied night
 * (hermes-dream-chats.js) with one call on its own model (hermes-dream.js), beside any
 * turn it runs. Each night with chats leaves one diary entry (hermes-dream-store.js).
 */

const hourMs = 3600000;
const dayMs = 24 * hourMs;
// A night missed at its hour (AgentPier down, the host not ready) is caught up within
// this long after it.
const catchUpMs = 6 * hourMs;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
// The wall clock of instant `ms` in `timeZone`, as if it were UTC.
function wall(ms, timeZone) {
  const t = localTime(new Date(ms), timeZone);
  return (
    Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute) +
    (((ms % 60000) + 60000) % 60000)
  );
}
// The first instant on local date `date` (UTC midnight of it) at or after `hour`: the
// hour itself, its first pass on a night the clock falls back, the jump on a night
// the clock springs over it.
function hourStart(date, hour, timeZone) {
  const target = date + hour * hourMs;
  const candidates = [target - 12 * hourMs, target + 12 * hourMs].map(
    (ms) => target - (wall(ms, timeZone) - ms),
  );
  const exact = candidates.filter((ms) => wall(ms, timeZone) === target);
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}

/**
 * The night `now` belongs to: the local date (YYYY-MM-DD) of the `hour` in
 * `timeZone` that `now` lies at most six hours after, or null outside those hours.
 */
export function dreamNight(now, { hour, timeZone }) {
  const t = localTime(now, timeZone);
  const today = Date.UTC(t.year, t.month - 1, t.day);
  for (const date of [today, today - dayMs]) {
    const start = hourStart(date, hour, timeZone);
    if (now.getTime() >= start && now.getTime() < start + catchUpMs) return isoDate(date);
  }
  return null;
}

const failed = {
  outcome: "failed",
  reason: "unavailable",
  file: null,
  counts: null,
  chars: null,
  summary: "",
};

export class HermesDreams {
  constructor({ settings, assistants, store, clock = () => new Date(), keep = 7 }) {
    Object.assign(this, { settings, assistants, store, clock, keep });
    // Hears each recorded night (the memory page's live topic).
    this.onChange = () => {};
    this.running = false;
  }
  get memory() {
    return this.assistants.nativeMemory ?? new NativeMemory(this.assistants);
  }
  /**
   * The agents to dream now: dreaming is on, `now` is in a night none of them dreamed
   * yet, and each is a Hermes agent with memory, not archived or being deleted, whose
   * host is ready. One whose host is not ready stays due for a later minute.
   */
  due(now) {
    const { enabled, hour, timeZone } = this.settings.get();
    if (!enabled || !this.assistants.runtime?.paths) return [];
    const night = dreamNight(now, { hour, timeZone });
    if (!night) return [];
    return this.assistants.store
      .listAssistants()
      .filter(
        (agent) =>
          runtimeIdOf(agent) === "hermes" &&
          !agent.archivedAt &&
          !agent.deletingAt &&
          memoryEnabled(agent) &&
          this.store.night(agent.id) !== night &&
          this.ready(agent),
      );
  }
  ready(agent) {
    try {
      return hostReady(this.assistants.runtime, agent);
    } catch {
      return false;
    }
  }
  /**
   * Dreams every due agent, one after another, outside admission; a tick while one
   * runs returns at once. The recorded entries.
   */
  async tick(now = this.clock()) {
    if (this.running) return [];
    this.running = true;
    try {
      const entries = [];
      const done = new Set();
      // Read again before each agent: one archived meanwhile is left out.
      for (;;) {
        const agent = this.due(now).find((a) => !done.has(a.id));
        if (!agent) return entries;
        done.add(agent.id);
        const entry = await this.dream(agent, now);
        if (entry) entries.push(entry);
      }
    } finally {
      this.running = false;
    }
  }
  /**
   * One night of `agent`: its diary entry, or null when no chat is new. The night is
   * marked first, so a crash never repeats it. The cursor moves only on an applied
   * night; a first night that applied nothing keeps the start of its window, so the
   * next one reads the same chats again.
   */
  async dream(agent, now) {
    const { hour, timeZone } = this.settings.get();
    const night =
      dreamNight(now, { hour, timeZone }) ?? isoDate(wall(now.getTime(), timeZone));
    this.store.markNight(agent.id, night);
    const cursor = this.store.cursor(agent.id);
    const since = cursor ?? now.getTime() - dayMs;
    let result;
    let until = null;
    try {
      const runtime = runtimeFor(agent, this.assistants.runtime);
      const read = await dreamChats({
        store: this.assistants.store,
        sessions: runtime.sessions,
        assistantId: agent.id,
        since,
        budget: dreamChatBudget,
      });
      if (!read.chats.length) return null;
      until = read.until;
      await this.assistants.admit(() => this.memory.prepare(agent.id));
      const once = () =>
        dreamOnce({
          files: runtime.agentFiles,
          sessions: runtime.sessions,
          agentId: agent.runtimeAgentId,
          chats: read.chats,
          admit: (fn) => this.assistants.admit(fn),
          backup: (contents) =>
            backupHermesMemory(this.assistants.runtime.paths, agent, contents, {
              keep: this.keep,
              now,
            }),
        });
      // A chat wrote a file meanwhile: once more against it, then the next night.
      result = await once();
      if (result.outcome === "conflict") result = await once();
      if (result.outcome === "conflict") result = { ...result, outcome: "postponed" };
    } catch (error) {
      // Codes only: never memory or chat text.
      console.warn("Hermes dream failed:", error?.code || error?.key || "UNAVAILABLE");
      result = failed;
    }
    if (result.outcome === "applied") this.store.applied(agent.id, until);
    else if (cursor === null) this.store.applied(agent.id, since);
    const { outcome, reason, file, counts, chars, summary } = result;
    const entry = {
      at: now.toISOString(),
      night,
      outcome,
      reason,
      file,
      counts,
      chars,
      summary,
    };
    this.store.append(agent.id, entry);
    try {
      this.onChange(agent.id);
    } catch {
      /* A listener's failure never undoes the night. */
    }
    return entry;
  }
}
