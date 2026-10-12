import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
// `auth_status` of `codex mcp list --json` (docs/cli-mcp-qualification.md).
export const codexAuthStates = { o_auth: "connected", not_logged_in: "login-required" };
const statusTtlMs = 30000;

/** The command that logs server `name` in, in the CLI itself. */
export function loginCommand(cli, name) {
  if (cli === "claude") return "/mcp";
  if (cli === "codex") return `codex mcp login ${name}`;
  return `opencode mcp auth ${name}`;
}

/**
 * OAuth login state in Codex, the only CLI with machine-readable status:
 * `{ [name]: "connected" | "login-required" | "unknown" }`, read at most every half
 * minute. Runs the installed Codex on the owner's canonical profile (`local-codex`, as
 * its sessions do), killed after ten seconds. A caller waits at most `wait` ms and
 * then gets the last known answer, so a slow CLI never holds up a page. The output
 * (which lists header values) never leaves this class, and failures are not logged.
 */
export class CliOAuthStatus {
  constructor({ tools, accounts, run = execute, now = Date.now, wait = 2000 }) {
    Object.assign(this, { tools, accounts, run, now, wait });
    this.cache = null;
    this.last = {};
  }
  codex() {
    if (!this.cache || this.now() - this.cache.at >= statusTtlMs) {
      const promise = this.read()
        .catch(() => ({}))
        .then((states) => (this.last = states));
      this.cache = { at: this.now(), promise };
    }
    return this.bounded(this.cache.promise);
  }
  bounded(promise) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(this.last), this.wait);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }
  async read() {
    const tool = this.tools().find((item) => item.id === "codex" && item.installed);
    if (!tool) return {};
    const { stdout } = await this.run(tool.path, ["mcp", "list", "--json"], {
      env: this.accounts.environment("local-codex"),
      cwd: this.accounts.home,
      timeout: 10000,
      maxBuffer: 1 << 20,
    });
    const list = JSON.parse(stdout);
    return Object.fromEntries(
      (Array.isArray(list) ? list : [])
        .filter((entry) => typeof entry?.name === "string")
        .map((entry) => [entry.name, codexAuthStates[entry.auth_status] ?? "unknown"]),
    );
  }
}
