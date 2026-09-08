import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
const execute = promisify(execFile);
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
  }
  async get(id) {
    const account = this.accounts.get(id);
    if (!Object.hasOwn(statusArgs, account.tool) || account.provider || account.hasSecret)
      return { state: "unsupported" };
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.checkedAt < 10000) return cached;
    if (this.pending.has(id)) return this.pending.get(id);
    const pending = this.probe(account).finally(() => this.pending.delete(id));
    this.pending.set(id, pending);
    return pending;
  }
  async probe(account) {
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
        ({ stdout, stderr } = await execute(tool.path, statusArgs[account.tool], {
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
    if (this.cache.size >= 1000) this.cache.clear();
    this.cache.set(account.id, result);
    return result;
  }
  close() {
    for (const controller of this.controllers) controller.abort();
    this.cache.clear();
  }
}
