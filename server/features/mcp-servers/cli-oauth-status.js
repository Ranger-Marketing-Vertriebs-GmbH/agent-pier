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
 * `{ [name]: "connected" | "login-required" | "unknown" }`, for the owner's canonical
 * profile (`local-codex`, as its sessions run) and for each AgentPier-managed Codex
 * account, whose MCP logins live in its own CODEX_HOME (file store, pinned with its
 * `-c` overrides). Stale-while-revalidate: `codex()` and `accountStates()` answer at
 * once with the last known states (none, i.e. unknown, on a cold start) and start at
 * most one background read when they are older than half a minute; no request ever
 * waits for Codex. Each read is killed after ten seconds. A failed read keeps that
 * profile's last states and logs its code only; the output (which lists header
 * values) never leaves this class.
 */
export class CliOAuthStatus {
  constructor({ tools, accounts, run = execute, now = Date.now, warn = console.warn }) {
    Object.assign(this, { tools, accounts, run, now, warn });
    this.last = {};
    this.managedStates = {};
    // Marks of completed logins: { [accountId]: { [name]: { state, seq } } }.
    this.marks = {};
    this.seq = 0;
    this.readAt = null;
    this.pending = null;
  }
  /** The managed Codex accounts AgentPier can log in (`{ id, name }`). */
  managed() {
    return (this.accounts.list?.() ?? [])
      .filter((account) => account.kind === "managed" && account.tool === "codex")
      .map((account) => ({ id: account.id, name: account.name }));
  }
  ensure() {
    if (
      !this.pending &&
      (this.readAt === null || this.now() - this.readAt >= statusTtlMs)
    )
      this.refresh();
  }
  codex() {
    this.ensure();
    return Promise.resolve(this.last);
  }
  /** `{ accounts: [{ id, name }], states: { [accountId]: { [name]: state } } }`. */
  accountStates() {
    this.ensure();
    return { accounts: this.managed(), states: this.managedStates };
  }
  /** A login AgentPier just completed shows before the next read confirms it. */
  mark(accountId, name, state) {
    this.seq += 1;
    this.marks[accountId] = {
      ...this.marks[accountId],
      [name]: { state, seq: this.seq },
    };
    this.managedStates = {
      ...this.managedStates,
      [accountId]: { ...this.managedStates[accountId], [name]: state },
    };
  }
  /** The next caller starts a new read. */
  invalidate() {
    this.readAt = null;
  }
  /** The background read; resolves once it has settled (tests wait on it). */
  refresh() {
    this.readAt = this.now();
    const since = this.seq;
    this.pending = (async () => {
      try {
        this.last = await this.read();
      } catch (error) {
        this.warn(`Codex MCP login status could not be read (${codeOf(error)}).`);
      }
      const states = { ...this.managedStates };
      const managed = this.managed();
      for (const account of managed)
        try {
          states[account.id] = await this.read(account.id);
        } catch (error) {
          this.warn(
            `Codex MCP login status of an account could not be read (${codeOf(error)}).`,
          );
        }
      // A mark newer than this read's start wins over its older answer; older
      // marks are settled by this read.
      for (const [id, names] of Object.entries(this.marks)) {
        for (const [name, mark] of Object.entries(names))
          if (mark.seq > since) states[id] = { ...states[id], [name]: mark.state };
          else delete names[name];
        if (!Object.keys(names).length) delete this.marks[id];
      }
      const known = new Set(managed.map((account) => account.id));
      this.managedStates = Object.fromEntries(
        Object.entries(states).filter(([id]) => known.has(id)),
      );
      this.pending = null;
    })();
    return this.pending;
  }
  /** Waits for a background read in progress, if any. */
  async settled() {
    await this.pending;
  }
  async read(accountId = "local-codex") {
    const tool = this.tools().find((item) => item.id === "codex" && item.installed);
    if (!tool) return {};
    const args = [
      ...(accountId === "local-codex"
        ? []
        : this.accounts.codexCredentialArgs(accountId)),
      "mcp",
      "list",
      "--json",
    ];
    const { stdout } = await this.run(tool.path, args, {
      env: this.accounts.environment(accountId),
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
