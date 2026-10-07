import path from "node:path";
import { execFile } from "node:child_process";

const urlForm = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?([^?#]*)/i;
const scpForm = /^([^@/]*)@([^/:]+:.*)$/;

/**
 * The remote as the browser may see it. URL remotes lose userinfo (which may hold a
 * token or a password), query and fragment. The scp-like form keeps a plain login
 * name (`git@host:owner/repo`), which carries no secret and is what the remote
 * display expects; a userinfo part with a `:` (password-like) is removed.
 */
export function publicRemote(value) {
  const remote = String(value || "").trim();
  if (!remote || /[\x00-\x1f\x7f]/.test(remote)) return "";
  const url = urlForm.exec(remote);
  if (url) return `${url[1]}${url[3]}`;
  const scp = scpForm.exec(remote);
  if (scp && scp[1].includes(":")) return scp[2];
  return remote;
}

/**
 * Reads `git remote get-url origin` for listed project folders. Read-only, local
 * (no network), bounded by a short timeout, at most `concurrency` git processes at a
 * time, and cached per folder for a few seconds. Missing git, a folder that is no
 * repository or has no origin all read as "".
 */
export class GitRemotes {
  constructor({
    git = "git",
    timeoutMs = 2000,
    ttlMs = 5000,
    concurrency = 4,
    now = Date.now,
  } = {}) {
    Object.assign(this, { git, timeoutMs, ttlMs, concurrency, now });
    this.cache = new Map();
    this.running = 0;
    this.waiting = [];
  }
  read(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd))
      return Promise.resolve("");
    const cached = this.cache.get(cwd);
    if (cached && cached.until > this.now()) return cached.value;
    for (const [key, item] of this.cache)
      if (item.until <= this.now()) this.cache.delete(key);
    const value = this.limited(() => this.lookup(cwd));
    this.cache.set(cwd, { value, until: this.now() + this.ttlMs });
    return value;
  }
  async limited(task) {
    // A finishing task hands its slot straight to the next waiting one.
    if (this.running >= this.concurrency)
      await new Promise((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
  lookup(cwd) {
    const env = {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    return new Promise((resolve) => {
      execFile(
        this.git,
        ["-C", cwd, "remote", "get-url", "origin"],
        { env, timeout: this.timeoutMs, maxBuffer: 16384, encoding: "utf8" },
        (error, stdout) => resolve(error ? "" : publicRemote(stdout.split("\n")[0])),
      );
    });
  }
  /** Adds the live `remote` of each item's folder under `key`. */
  async annotate(items, key) {
    return Promise.all(
      (items || []).map(async (item) => ({
        ...item,
        remote: await this.read(item[key]),
      })),
    );
  }
}

/** Only the projects hub asks for remotes (`?remotes=1`); other readers skip git. */
export function wantsRemotes(request) {
  return request.query?.remotes === "1";
}
