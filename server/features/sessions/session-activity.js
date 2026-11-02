import { serverMessages } from "../../lib/i18n/de.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify, stripVTControlCharacters } from "node:util";
import { parseModelPicker } from "../models/model-parser.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";
import { hookQuietMs, hookStaleMs, mergeActivity } from "./session-activity-merge.js";
const execute = promisify(execFile);
const labels = {
  working: serverMessages.sessions.activityWorking,
  idle: serverMessages.sessions.activityReady,
  waiting: serverMessages.sessions.activityWaiting,
  unknown: serverMessages.sessions.activityUnknown,
  stopped: serverMessages.sessions.activityStopped,
};
const result = (state, extra = {}) => ({
  state,
  label: labels[state],
  ...extra,
});
/** Recognize only current native chrome near the composer, never transcript text. */
export function parseSessionActivity(tool, raw) {
  if (typeof raw !== "string" || raw.length > 256 * 1024) return result("unknown");
  const original = raw.replaceAll("\u00a0", " ").trimEnd().split("\n").slice(-45);
  const lines = original.map(stripVTControlCharacters);
  while (lines.length && !lines.at(-1).trim()) {
    lines.pop();
    original.pop();
  }
  const last = lines.at(-1)?.trim() || "";
  const tail = lines.slice(-8).join("\n");
  if (parseModelPicker(tool, original.join("\n"))) return result("waiting");
  const dialog = lines.slice(-20, -1);
  const choices = dialog.filter((line) => /^\s*[❯›>]?[ \t]*\d+\.\s+\S/.test(line));
  if (
    choices.length >= 2 &&
    dialog.some((line) => /^\s*[❯›>]\s*\d+\.\s+\S/.test(line)) &&
    dialog.some((line) =>
      /^(?:Do you|Would you|Trust |Permission|Approve|Select |Allow )/i.test(line.trim()),
    ) &&
    /(?:enter to confirm|enter to select|enter to continue)/i.test(last) &&
    /(?:esc to (?:cancel|deny|go back)|escape to cancel)/i.test(last)
  )
    return result("waiting");
  if (!isCodingCli(tool)) return result("unknown");
  const { state, ...extra } = cliDriver(tool).tui.activity({
    lines,
    original,
    last,
    tail,
  });
  return result(state, extra);
}
export class SessionActivity {
  constructor({
    sessions,
    screen,
    cacheMs = 2500,
    concurrency = 3,
    now = Date.now,
    staleMs = 10000,
    // The CLI's own report (hooks, app-server, plugin) and AgentPier's open requests.
    hooks = () => null,
    pending = () => false,
    quietMs = hookQuietMs,
    hookStaleMs: reportStaleMs = hookStaleMs,
  } = {}) {
    this.sessions = sessions;
    Object.assign(this, { hooks, pending, quietMs, reportStaleMs });
    this.screens = new Map();
    // The report each session's terminal reading ended (see mergeActivity).
    this.ended = new Map();
    // Since when each running session is in its current state (`since`).
    this.states = new Map();
    this.cacheMs = cacheMs;
    this.now = now;
    this.staleMs = staleMs;
    this.limit = Math.max(1, Math.min(5, concurrency));
    this.active = 0;
    this.queue = [];
    this.cache = new Map();
    this.observations = new Map();
    this.screen =
      screen ||
      (async (session) => {
        const { stdout } = await execute(
          sessions.tmuxPath,
          [
            "-u",
            "-S",
            sessions.socketPath,
            "-f",
            sessions.configPath,
            "capture-pane",
            "-e",
            "-p",
            "-t",
            `${sessions.target(session.id)}:0.0`,
          ],
          {
            timeout: 1200,
            maxBuffer: 256 * 1024,
            env: {
              PATH: process.env.PATH || "",
              HOME: process.env.HOME || "",
              LANG: "en_US.UTF-8",
            },
          },
        );
        return stdout;
      });
  }
  async slot(fn) {
    if (this.active >= this.limit)
      await new Promise((resolve) => this.queue.push(resolve));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
  async read(value) {
    const session = typeof value === "string" ? await this.sessions.get(value) : value;
    if (session.status !== "running") {
      this.remove(session.id);
      return result("stopped");
    }
    if (session.tool === "shell" || session.purpose === "login") {
      this.remove(session.id);
      return result("unknown");
    }
    const key = JSON.stringify([
      session.id,
      session.tool,
      session.status,
      session.accountId,
      session.cwd,
    ]);
    const cached = this.cache.get(session.id);
    if (
      cached?.key === key &&
      (cached.pending || this.now() - cached.time < this.cacheMs)
    )
      return cached.promise;
    const entry = { key, time: this.now(), pending: true };
    entry.promise = this.slot(async () => {
      let parsed;
      try {
        const raw = await this.screen(session);
        this.screenChanged(session.id, raw);
        parsed = parseSessionActivity(session.tool, raw);
      } catch {
        parsed = result("unknown");
      }
      const time = this.now();
      let state = parsed.state;
      if (parsed.evidence) {
        const previous = this.observations.get(key);
        const changed = previous && previous.evidence !== parsed.evidence;
        const changedAt = changed ? time : previous?.changedAt;
        const firstAt = previous?.firstAt ?? time;
        this.observations.set(key, {
          evidence: parsed.evidence,
          changedAt,
          firstAt,
        });
        if (
          (parsed.animated && changedAt === undefined) ||
          time - (changedAt ?? firstAt) > this.staleMs
        )
          state = "unknown";
      } else this.observations.delete(key);
      const merged = await this.combine(session, state, time);
      entry.pending = false;
      entry.time = time;
      return result(merged.state, {
        ...merged,
        observedAt: new Date(time).toISOString(),
        since: this.since(session.id, merged.state, time),
      });
    });
    this.cache.set(session.id, entry);
    return entry.promise;
  }
  async enrich(sessions) {
    const live = new Set(sessions.map((session) => session.id));
    for (const id of this.cache.keys()) if (!live.has(id)) this.remove(id);
    return Promise.all(
      sessions.map(async (session) => ({
        ...session,
        activity: await this.read(session),
      })),
    );
  }
  async combine(session, pane, now) {
    let hook = null,
      pending = false;
    try {
      hook = await this.hooks(session);
      pending = !!(await this.pending(session.id));
    } catch {}
    const { ends, ...merged } = mergeActivity({
      pane,
      hook,
      pending,
      now,
      paneChangedAt: this.screens.get(session.id)?.changedAt,
      endedAt: this.ended.get(session.id),
      quietMs: this.quietMs,
      staleMs: this.reportStaleMs,
    });
    if (ends !== undefined) this.ended.set(session.id, ends);
    return merged;
  }
  /**
   * The same combined state for a screen the caller captured itself, without the
   * read cache: a reload's last check under the session lock must agree with the
   * state that let it start.
   */
  async settle(session, raw) {
    const pane = parseSessionActivity(session.tool, raw).state;
    const merged = await this.combine(session, pane, this.now());
    return result(merged.state, merged);
  }
  /** Remember when the screen last changed; a working CLI keeps animating it. */
  screenChanged(id, raw) {
    const digest = createHash("sha1").update(String(raw)).digest("hex");
    const previous = this.screens.get(id);
    if (previous?.digest !== digest)
      this.screens.set(id, { digest, changedAt: this.now() });
  }
  /**
   * When `id` entered `state`: kept while the state holds, else now. A passing
   * `unknown` reading (a frozen screen, a failed capture) neither starts a new span
   * nor ends one: the span runs on until a different known state follows.
   */
  since(id, state, time) {
    const previous = this.states.get(id);
    if (previous && (state === "unknown" || previous.state === state))
      return previous.since;
    if (previous?.state === null) {
      // The first known state after an unknown start keeps that start.
      this.states.set(id, { state, since: previous.since });
      return previous.since;
    }
    const next = {
      state: state === "unknown" ? null : state,
      since: new Date(time).toISOString(),
    };
    this.states.set(id, next);
    return next.since;
  }
  remove(id) {
    this.cache.delete(id);
    this.states.delete(id);
    this.screens.delete(id);
    this.ended.delete(id);
    for (const key of this.observations.keys())
      if (JSON.parse(key)[0] === id) this.observations.delete(key);
  }
}
