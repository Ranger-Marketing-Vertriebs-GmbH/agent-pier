import os from "node:os";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { adoptFinds, changeRefusal, patchFromNative } from "./cli-adoption.js";
import { groupFinds, publicFind } from "./cli-finds.js";
import { stdioGrants } from "./cli-grants.js";
import {
  centralFromNative,
  cliSupport,
  cliTargets,
  clis,
  requireCliSupport,
} from "./cli-native.js";
import { loginCommand } from "./cli-oauth-status.js";
import { CliMcpReconciler } from "./cli-reconciler.js";
import { adoptFailure, reasonIdentity, statusView } from "./cli-status.js";
import { resolveCommand } from "./command-resolution.js";
import { changesStdio, requireStdioConfirmation } from "./stdio-confirmation.js";

const messages = serverMessages.mcpServers;
// Only a stable error code is logged, never a message, path or value.
const codeOf = (error) =>
  typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : "ERROR";
// Whether the reconcile `result` of a CLI has server `id`'s AgentPier entry in effect.
const inEffect = (result, id) => result?.statuses?.[id]?.status === "written";

/**
 * Central MCP servers in the coding CLIs: each `cli` binding becomes an entry in the
 * CLI's canonical native profile (`local-<cli>`), which the shared-profile projection
 * carries to every managed account of that CLI. Runs after every saved change and
 * before every session start; never shows or logs a header or environment value.
 */
export class CliMcpBindings {
  constructor({
    servers,
    extensions,
    changes = () => null,
    agentNames = () => new Map(),
    oauthStatus = null,
    codexLogins = () => null,
    home = os.homedir(),
    dataDir = null,
    warn = console.warn,
  }) {
    Object.assign(this, { servers, changes, agentNames, oauthStatus, codexLogins, warn });
    // Directories a server's cwd must never open up to the sandbox (cli-grants.js).
    this.protectedDirs = { home, dataDir };
    this.reconciler = new CliMcpReconciler({
      servers,
      locate: (cli) => extensions.locations(`local-${cli}`),
      configs: (locations) => extensions.configs(locations),
      warn,
    });
  }
  /**
   * Brings every CLI in step with the store; one CLI never stops the others and never
   * throws, so a change that is already stored still answers success. The next
   * session start (prepare) repairs what failed here.
   */
  reconcileAll() {
    const results = Object.fromEntries(clis.map((cli) => [cli, this.reconcileOne(cli)]));
    // A server deleted, renamed or unbound from Codex ends its brokered logins.
    try {
      this.codexLogins()?.prune();
    } catch (error) {
      this.warn(`Codex MCP logins could not be checked (${codeOf(error)}).`);
    }
    return results;
  }
  /** `reconcile(cli)`; a store or programming error is logged by code and reported as `failed`. */
  reconcileOne(cli) {
    try {
      return this.reconciler.reconcile(cli);
    } catch (error) {
      this.warn(`MCP servers for ${cli} could not be prepared (${codeOf(error)}).`);
      const statuses = {};
      try {
        for (const serverId of this.servers.bindings("cli", cli))
          statuses[serverId] = { status: "error", reason: "failed" };
      } catch {
        // The store itself failed; there is nothing to report per server.
      }
      return { cli, error: "failed", statuses, actions: [], finds: [] };
    }
  }
  inspectAll() {
    return Object.fromEntries(clis.map((cli) => [cli, this.reconciler.inspect(cli)]));
  }
  /** The list as responses show it: bound CLIs, their support and status, and users. */
  async decorate(list) {
    const results = this.inspectAll();
    const names = this.agentNames();
    const oauth = await this.oauthStates(list, results);
    return list.map((server) => {
      const targets = this.servers.targetsOf(server.id);
      return {
        ...server,
        clis: targets.clis,
        cliSupport: Object.fromEntries(clis.map((cli) => [cli, cliSupport(cli, server)])),
        cliStatus: Object.fromEntries(
          targets.clis.map((cli) => [
            cli,
            {
              ...statusView(results[cli].statuses[server.id] ?? { status: "pending" }),
              ...(oauth[cli]?.[server.id] ? { oauth: oauth[cli][server.id] } : {}),
            },
          ]),
        ),
        users: {
          agents: targets.agents.map((id) => names.get(id)).filter(Boolean),
          clis: targets.clis,
        },
      };
    });
  }
  async server(id) {
    return (await this.decorate([this.servers.get(id)]))[0];
  }
  /**
   * `{ [cli]: { [serverId]: { state, command } } }` for OAuth servers whose entry is in
   * effect in a CLI (`written` in `results`): Codex reports its login state; for the
   * others the owner sees the login command. Codex also lists each AgentPier-managed
   * account (`accounts`, see codexAccounts). A login state is read by name, so a
   * server whose name the owner's own entry holds (or that is not written) shows none.
   */
  async oauthStates(list, results = this.inspectAll()) {
    const oauth = list.filter(
      (server) => server.auth === "oauth" && server.transport !== "stdio",
    );
    const out = {};
    for (const cli of clis) {
      const mine = oauth.filter((server) => inEffect(results[cli], server.id));
      if (!mine.length) continue;
      const codex = cli === "codex" && this.oauthStatus;
      const known = codex ? await this.oauthStatus.codex() : {};
      const managed = codex ? this.oauthStatus.accountStates() : null;
      out[cli] = Object.fromEntries(
        mine.map((server) => [
          server.id,
          {
            state: known[server.name] ?? "unknown",
            command: loginCommand(cli, server.name),
            ...(managed ? { accounts: this.codexAccounts(server, managed) } : {}),
          },
        ]),
      );
    }
    return out;
  }
  /**
   * Per managed Codex account `{ id, name, state, reason? }`: "pending" while a
   * brokered login waits for its callback, "connected" when Codex holds a login,
   * "failed" (with a stable reason) after AgentPier's last login failed, otherwise what
   * Codex reports ("login-required" or "unknown").
   */
  codexAccounts(server, { accounts, states }) {
    const activity = this.codexLogins()?.view(server.id) ?? {};
    return accounts.map(({ id, name }) => {
      const read = states[id]?.[server.name] ?? "unknown";
      const last = activity[id];
      if (last?.pending) return { id, name, state: "pending" };
      if (read !== "connected" && last?.result === "error")
        return { id, name, state: "failed", reason: last.reason };
      return { id, name, state: read };
    });
  }
  findGroups(results = this.inspectAll()) {
    return groupFinds(
      results,
      this.servers.list().map((server) => server.name),
    );
  }
  /**
   * The owner's own entries in the CLIs as responses show them (names only), and each
   * CLI whose file could not be read as `{ cli, reason, messageKey }`.
   */
  finds() {
    const results = this.inspectAll();
    const resolve = (command) => resolveCommand(command, this.servers.resolveOptions);
    return {
      finds: this.findGroups(results).map((group) => publicFind(group, { resolve })),
      problems: clis
        .filter((cli) => results[cli].error)
        .map((cli) => ({
          cli,
          reason: results[cli].error,
          ...reasonIdentity(results[cli].error),
        })),
    };
  }
  /**
   * Adopts finds (`adoptFinds`). Chosen by `keys`, each key is adopted on its own: a
   * key that fails is reported in `failed` with a stable reason and never undoes or
   * hides the keys adopted before it.
   */
  adopt(body = {}) {
    const options = {
      servers: this.servers,
      reconciler: this.reconciler,
      groups: this.findGroups(),
      names: body.names ?? {},
      warn: this.warn,
    };
    let result;
    if (body.all === true) result = adoptFinds({ ...options, all: true });
    else {
      const keys = body.keys;
      if (
        !Array.isArray(keys) ||
        !keys.length ||
        keys.some((key) => typeof key !== "string") ||
        !record(options.names)
      )
        throw problem(messages.invalidRequest, 400);
      result = { adopted: [], failed: [] };
      for (const key of new Set(keys))
        try {
          result.adopted.push(...adoptFinds({ ...options, keys: [key] }).adopted);
        } catch (error) {
          const group = options.groups.find((item) => item.key === key);
          result.failed.push({
            key,
            ...(group ? { name: group.name } : {}),
            ...adoptFailure(error, this.warn),
          });
        }
    }
    this.reconcileAll();
    return result;
  }
  /** Binds server `id` to exactly `wanted`; a CLI that cannot run it is refused. */
  async setClis(id, wanted, { confirmStdio = false } = {}) {
    const next = cliTargets(wanted);
    const server = this.servers.get(id);
    const current = this.servers.targetsOf(id).clis;
    const added = next.filter((cli) => !current.includes(cli));
    requireCliSupport(added, server);
    if (server.transport === "stdio" && added.length)
      requireStdioConfirmation(confirmStdio === true);
    this.servers.setClis(id, next);
    this.reconcileAll();
    return {
      clis: next,
      added,
      removed: current.filter((cli) => !next.includes(cli)),
      // Audited only when the owner confirmed a command that now runs in a new CLI.
      stdioConfirmed: server.transport === "stdio" && added.length > 0 && confirmStdio,
    };
  }
  /**
   * The owner's choice for a conflict or a taken name in `cli`: "overwrite" writes
   * AgentPier's version (conflicts only); "adopt" moves the owner's entry into the
   * central server (which every bound CLI and agent then gets) and makes it AgentPier's.
   * Returns the server fields an adoption changed and whether the owner confirmed a
   * changed stdio command (the update below confirms on the owner's behalf).
   */
  async resolve(id, cli, choice, { confirmStdio = false } = {}) {
    if (!clis.includes(cli) || !["overwrite", "adopt"].includes(choice))
      throw problem(messages.invalidRequest, 400);
    if (choice === "overwrite") {
      this.reconciler.overwrite(id, cli);
      return { fields: [], stdioConfirmed: false };
    }
    const found = this.reconciler.contested(id, cli);
    const parsed = centralFromNative(cli, found.entry);
    if (!parsed.ok) throw changeRefusal(parsed);
    const server = this.servers.get(id);
    const patch = patchFromNative(server, cli, parsed);
    const stdioChanged = changesStdio(server, patch);
    if (stdioChanged) requireStdioConfirmation(confirmStdio === true);
    const changes = this.changes();
    if (changes) await changes.update(id, patch, { confirmStdio: true });
    else this.servers.update(id, patch);
    this.reconciler.claim(id, cli, found.hash);
    this.reconcileAll();
    return {
      fields: Object.keys(patch).filter((key) => key !== "revision"),
      stdioConfirmed: stdioChanged && confirmStdio === true,
    };
  }
  /** Ids of the servers whose AgentPier entry `cli` runs now. */
  inEffect(cli) {
    const result = this.reconciler.inspect(cli);
    return new Set(
      this.servers.bindings("cli", cli).filter((id) => inEffect(result, id)),
    );
  }
  /**
   * Before a session of `account` starts: its CLI is brought in step (a missing managed
   * entry is restored, a conflict left alone) and the sandbox is granted what each
   * bound stdio server runs whose AgentPier entry is in effect there. A server whose
   * name the owner's own entry holds, whose entry the owner edited (conflict) or that
   * could not be written runs the owner's command or none: it gets no grant. Never
   * fails the launch; problems are logged by code.
   */
  async prepare({ account, launch, purpose }) {
    if (purpose === "login" || !clis.includes(account.tool)) return launch;
    const result = this.reconcileOne(account.tool);
    try {
      const definitions = this.servers
        .definitions()
        .filter(
          (definition) =>
            inEffect(result, definition.id) &&
            definition.transport === "stdio" &&
            cliSupport(account.tool, definition).supported,
        );
      let next = launch;
      const options = {
        pathEnv: launch.env?.PATH ?? "",
        ...this.protectedDirs,
        warn: this.warn,
      };
      for (const grant of stdioGrants(definitions, options)) next = addGrant(next, grant);
      return next;
    } catch (error) {
      this.warn(`MCP sandbox grants for ${account.tool} are missing (${codeOf(error)}).`);
      return launch;
    }
  }
}
