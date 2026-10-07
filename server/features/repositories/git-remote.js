import path from "node:path";
import { execFile } from "node:child_process";

const urlForm = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?([^?#]*)/i;

/**
 * The remote as the browser may see it: userinfo (which may hold a token or a
 * password), query and fragment are removed from URL remotes. The scp-like form
 * `user@host:path` names only a login user and stays as it is.
 */
export function publicRemote(value) {
  const remote = String(value || "").trim();
  if (!remote || /[\x00-\x1f\x7f]/.test(remote)) return "";
  const match = urlForm.exec(remote);
  if (match) return `${match[1]}${match[3]}`;
  return remote;
}

/**
 * Reads `git remote get-url origin` for listed project folders. Read-only, local
 * (no network), bounded by a short timeout and cached per folder for a few seconds.
 * Missing git, a folder that is no repository or has no origin all read as "".
 */
export class GitRemotes {
  constructor({ git = "git", timeoutMs = 2000, ttlMs = 5000, now = Date.now } = {}) {
    Object.assign(this, { git, timeoutMs, ttlMs, now });
    this.cache = new Map();
  }
  read(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd))
      return Promise.resolve("");
    const cached = this.cache.get(cwd);
    if (cached && cached.until > this.now()) return cached.value;
    for (const [key, item] of this.cache)
      if (item.until <= this.now()) this.cache.delete(key);
    const value = this.lookup(cwd);
    this.cache.set(cwd, { value, until: this.now() + this.ttlMs });
    return value;
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
