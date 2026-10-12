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

// Only a stable error code is logged, never the CLI's output, a message or a path.
const codeOf = (error) =>
  typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : "ERROR";

/**
 * OAuth login state in Codex, the only CLI with machine-readable status:
 * `{ [name]: "connected" | "login-required" | "unknown" }`. Stale-while-revalidate:
 * `codex()` answers at once with the last known states (`{}`, i.e. unknown, on a
 * cold start) and starts at most one background read when they are older than half
 * a minute; no request ever waits for Codex. The read runs the installed Codex on the
 * owner's canonical profile (`local-codex`, as its sessions do) and is killed after
 * ten seconds. A failed read keeps the last states and logs its code only; the output
 * (which lists header values) never leaves this class.
 */
export class CliOAuthStatus {
  constructor({ tools, accounts, run = execute, now = Date.now, warn = console.warn }) {
    Object.assign(this, { tools, accounts, run, now, warn });
    this.last = {};
    this.readAt = null;
    this.pending = null;
  }
  codex() {
    if (
      !this.pending &&
      (this.readAt === null || this.now() - this.readAt >= statusTtlMs)
    )
      this.refresh();
    return Promise.resolve(this.last);
  }
  /** The background read; resolves once it has settled (tests wait on it). */
  refresh() {
    this.readAt = this.now();
    this.pending = (async () => {
      try {
        this.last = await this.read();
      } catch (error) {
        this.warn(`Codex MCP login status could not be read (${codeOf(error)}).`);
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
  /** Waits for a background read in progress, if any. */
  async settled() {
    await this.pending;
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
