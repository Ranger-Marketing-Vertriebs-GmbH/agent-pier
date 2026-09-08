import { serverMessages } from "../../lib/i18n/de.js";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { parseModelPicker } from "../models/model-parser.js";
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
const border = (line) => /^\s*[─━]{8,}\s*$/.test(line);
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
  if (
    tool === "opencode" &&
    /enter\s+confirm/i.test(tail) &&
    /Allow once\s+Allow always\s+Reject/.test(tail)
  )
    return result("waiting");
  if (tool === "opencode") {
    const prompt = lines.findLastIndex((line) => /┃\s+[^·\n]+·\s+\S/.test(line));
    if (prompt < 0 || prompt < lines.length - 12) return result("unknown");
    if (/\S[^\n]*\S[ \t]{2,}esc\s*$/.test(tail)) return result("unknown");
    if (/\besc\s+(?:again to )?interrupt\b/.test(last))
      return result("working", { evidence: last });
    if (/\bctrl\+p\s+commands\b/.test(last)) return result("idle");
    return result("unknown");
  }
  if (!["claude", "codex"].includes(tool)) return result("unknown");
  const prompt = lines.findLastIndex((line) => /^\s*[❯›](?:\s|$)/.test(line));
  if (prompt < 0 || prompt < lines.length - 10) return result("unknown");
  const footer = lines.slice(prompt + 1).join("\n");
  if (
    !/(?:for shortcuts|context left|context window|gpt-|codex-|auto mode|manual mode|shift\+tab|bypass permissions|Opus|Sonnet|Haiku)/i.test(
      footer,
    )
  )
    return result("unknown");
  if (/Input disabled\.|Viewing sub-agent/i.test(lines.slice(prompt).join("\n")))
    return result("unknown");
  if (tool === "codex") {
    let index = prompt - 1;
    while (index >= 0 && !lines[index].trim()) index--;
    const status = lines[index]?.trim() || "";
    const styled = /\x1b\[(?:\d+;)*2(?:;\d+)*m/.test(original[index] || "");
    if (
      /^(?:[•●◦◉◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+[^\n]{1,140}|(?:Working|Thinking|Running|Reconnecting|Waiting for background terminal)[^\n]{0,100})\(\d+(?:h\s+\d+m\s+\d+s|m\s+\d+s|s)\s+[•·]\s+esc to interrupt\)/.test(
        status,
      ) &&
      styled
    )
      return result("working", { evidence: status });
    if (/esc to interrupt/.test(status)) return result("unknown");
    return result("idle");
  }
  // Claude's current spinner omits the interrupt hint in some modes. Its native
  // animated row sits directly above the ruled composer and includes elapsed time.
  if (
    !border(lines[prompt - 1] || "") ||
    !lines.slice(prompt + 1, prompt + 8).some(border)
  )
    return result("unknown");
  let index = prompt - 2;
  while (index >= 0 && !lines[index].trim()) index--;
  const status = lines[index]?.trim() || "";
  if (
    /^[✻✽✶✳✢·*]\s+[^\n]{1,120}…\s*\(\d+(?:h\s+\d+m\s+\d+s|m\s+\d+s|s)\s*[·•]/.test(
      status,
    ) &&
    /\x1b\[(?:\d+;)*38;/.test(original[index] || "")
  )
    return result("working", { evidence: status, animated: true });
  return result("idle");
}
export class SessionActivity {
  constructor({
    sessions,
    screen,
    cacheMs = 2500,
    concurrency = 3,
    now = Date.now,
    staleMs = 10000,
  } = {}) {
    this.sessions = sessions;
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
        parsed = parseSessionActivity(session.tool, await this.screen(session));
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
      entry.pending = false;
      entry.time = time;
      return result(state, {
        source: "native-terminal",
        observedAt: new Date(time).toISOString(),
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
  remove(id) {
    this.cache.delete(id);
    for (const key of this.observations.keys())
      if (JSON.parse(key)[0] === id) this.observations.delete(key);
  }
}
