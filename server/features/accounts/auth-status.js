import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
const execute = promisify(execFile);
// CLI status probes that run at once across accounts; more wait their turn.
export const MAX_AUTH_PROBES = 3;
const statusArgs = {
  claude: ["auth", "status", "--json"],
  codex: ["login", "status"],
  opencode: ["auth", "list"],
};

/** Read native authentication state without exposing the CLI's credential metadata. */
export class AccountAuthStatus {
  constructor({ accounts, tools, home }) {
    Object.assign(this, { accounts, tools, home });
    this.cache = new Map();
    this.pending = new Map();
    this.controllers = new Set();
    // Raised by forget() (of every account, or of one in `generations`): a probe
    // started before it never fills the cache; other accounts' probes still do.
    this.generation = 0;
    this.generations = new Map();
    this.running = 0;
    this.queued = [];
  }
  async get(id) {
    const account = this.accounts.get(id);
    if (!Object.hasOwn(statusArgs, account.tool) || account.provider || account.hasSecret)
      return { state: "unsupported" };
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.checkedAt < 10000) return cached;
    if (this.pending.has(id)) return this.pending.get(id);
    const pending = this.probe(account).finally(() => {
      if (this.pending.get(id) === pending) this.pending.delete(id);
    });
    this.pending.set(id, pending);
    return pending;
  }
  /** What a probe of `id` started now must still match to fill the cache. */
  stamp(id) {
    return `${this.generation}:${this.generations.get(id) || 0}`;
  }
  async probe(account) {
    const generation = this.stamp(account.id);
    await this.slot();
    try {
      return await this.run(account, generation);
    } finally {
      this.release();
    }
  }
  slot() {
    if (this.running < MAX_AUTH_PROBES) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queued.push(resolve));
  }
  release() {
    const next = this.queued.shift();
    if (next) next();
    else this.running -= 1;
  }
  async run(account, generation) {
    const result = { state: "unknown", checkedAt: Date.now() };
    const tool = this.tools().find(
      (entry) => entry.id === account.tool && entry.installed,
    );
    if (!tool) return result;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      let stdout;
      let stderr;
      let exitCode = 0;
      try {
        const args = [
          ...(account.tool === "codex"
            ? this.accounts.codexCredentialArgs(account.id)
            : []),
          ...statusArgs[account.tool],
        ];
        ({ stdout, stderr } = await execute(tool.path, args, {
          env: this.accounts.environment(account.id),
          cwd: this.home,
          timeout: 6000,
          maxBuffer: 32768,
          signal: controller.signal,
        }));
      } catch (error) {
        if (error.code !== 1) return result;
        stdout = error.stdout;
        stderr = error.stderr;
        exitCode = error.code;
      }
      if (account.tool === "claude") {
        const status = JSON.parse(stdout);
        if (status.loggedIn === true) result.state = "authenticated";
        if (status.loggedIn === false) result.state = "unauthenticated";
      } else {
        const output = stripVTControlCharacters(`${stdout || ""}\n${stderr || ""}`);
        if (account.tool === "codex") {
          if (exitCode === 0 && /^Logged in using .+/m.test(output))
            result.state = "authenticated";
          if (exitCode === 1 && /^Not logged in\s*$/m.test(output))
            result.state = "unauthenticated";
        } else if (exitCode === 0) {
          const count = output.match(/^\s*└\s+(\d+) credentials?\s*$/m);
          if (count)
            result.state = Number(count[1]) > 0 ? "authenticated" : "unauthenticated";
        }
      }
    } catch {
      // A missing binary, unknown CLI version or timeout is not a logout result.
    } finally {
      this.controllers.delete(controller);
    }
    if (generation !== this.stamp(account.id)) return result;
    if (this.cache.size >= 1000) this.cache.clear();
    this.cache.set(account.id, result);
    return result;
  }
  /**
   * Drops the cached state and the running probe of `id` (of every account without
   * one): the next read probes anew, and a probe already running fills no cache.
   */
  forget(id) {
    // Every account, or the per-account stamps grew past their bound.
    if (id === undefined || this.generations.size >= 1000) {
      this.generation += 1;
      this.generations.clear();
    }
    if (id === undefined) {
      this.cache.clear();
      this.pending.clear();
    } else {
      this.generations.set(id, (this.generations.get(id) || 0) + 1);
      this.cache.delete(id);
      this.pending.delete(id);
    }
  }
  close() {
    for (const controller of this.controllers) controller.abort();
    this.cache.clear();
  }
}
