import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { adoptFinds, patchFromNative } from "./cli-adoption.js";
import { groupFinds, publicFind } from "./cli-finds.js";
import { stdioGrants } from "./cli-grants.js";
import { centralFromNative, cliSupport, clis, requireCliSupport } from "./cli-native.js";
import { CliMcpReconciler } from "./cli-reconciler.js";
import { changesStdio, requireStdioConfirmation } from "./stdio-confirmation.js";

const messages = serverMessages.mcpServers;
// Only a stable error code is logged, never a message, path or value.
const codeOf = (error) =>
  typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : "ERROR";

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
    warn = console.warn,
  }) {
    Object.assign(this, { servers, changes, agentNames, oauthStatus, warn });
    this.reconciler = new CliMcpReconciler({
      servers,
      locate: (cli) => extensions.locations(`local-${cli}`),
      configs: (locations) => extensions.configs(locations),
      warn,
    });
  }
  /** Brings every CLI in step with the store; one CLI's file never stops the others. */
  reconcileAll() {
    return Object.fromEntries(clis.map((cli) => [cli, this.reconciler.reconcile(cli)]));
  }
  inspectAll() {
    return Object.fromEntries(clis.map((cli) => [cli, this.reconciler.inspect(cli)]));
  }
  /** The list as responses show it: bound CLIs, their support and status, and users. */
  async decorate(list) {
    const results = this.inspectAll();
    const names = this.agentNames();
    const oauth = await this.oauthStates(list);
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
              ...(results[cli].statuses[server.id] ?? { status: "pending" }),
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
  /** OAuth login state per CLI and server id (Task 8). */
  async oauthStates() {
    return {};
  }
  findGroups() {
    return groupFinds(
      this.inspectAll(),
      this.servers.list().map((server) => server.name),
    );
  }
  finds() {
    return this.findGroups().map(publicFind);
  }
  adopt(body = {}) {
    const result = adoptFinds({
      servers: this.servers,
      reconciler: this.reconciler,
      groups: this.findGroups(),
      keys: body.keys,
      names: body.names ?? {},
      all: body.all === true,
    });
    this.reconcileAll();
    return result;
  }
  /** Binds server `id` to exactly `wanted`; a CLI that cannot run it is refused. */
  async setClis(id, wanted, { confirmStdio = false } = {}) {
    if (!Array.isArray(wanted) || wanted.some((cli) => !clis.includes(cli)))
      throw problem(messages.invalidTarget, 400);
    const server = this.servers.get(id);
    const current = this.servers.targetsOf(id).clis;
    const next = clis.filter((cli) => wanted.includes(cli));
    const added = next.filter((cli) => !current.includes(cli));
    requireCliSupport(added, server);
    if (server.transport === "stdio" && added.length)
      requireStdioConfirmation(confirmStdio === true);
    this.servers.setClis(id, next);
    this.reconcileAll();
    return { clis: next, added, removed: current.filter((cli) => !next.includes(cli)) };
  }
  /**
   * The owner's choice for a conflict or a taken name in `cli`: "overwrite" writes
   * AgentPier's version (conflicts only); "adopt" moves the owner's entry into the
   * central server (which every bound CLI and agent then gets) and makes it AgentPier's.
   */
  async resolve(id, cli, choice, { confirmStdio = false } = {}) {
    if (!clis.includes(cli) || !["overwrite", "adopt"].includes(choice))
      throw problem(messages.invalidRequest, 400);
    if (choice === "overwrite") {
      this.reconciler.overwrite(id, cli);
      return;
    }
    const found = this.reconciler.contested(id, cli);
    const parsed = centralFromNative(cli, found.entry);
    if (!parsed.ok) throw problem(messages.cliChangeNotAdoptable, 409);
    const server = this.servers.get(id);
    const patch = patchFromNative(server, cli, parsed);
    if (changesStdio(server, patch)) requireStdioConfirmation(confirmStdio === true);
    const changes = this.changes();
    if (changes) await changes.update(id, patch, { confirmStdio: true });
    else this.servers.update(id, patch);
    this.reconciler.claim(id, cli, found.hash);
    this.reconcileAll();
  }
  /**
   * Before a session of `account` starts: its CLI is brought in step (a missing managed
   * entry is restored, a conflict left alone) and the sandbox is granted what each
   * bound stdio server runs. Never fails the launch; problems are logged by code.
   */
  async prepare({ account, launch, purpose }) {
    if (purpose === "login" || !clis.includes(account.tool)) return launch;
    try {
      this.reconciler.reconcile(account.tool);
    } catch (error) {
      this.warn(
        `MCP servers for ${account.tool} could not be prepared (${codeOf(error)}).`,
      );
    }
    try {
      const bound = new Set(this.servers.bindings("cli", account.tool));
      const definitions = this.servers
        .definitions()
        .filter(
          (definition) =>
            bound.has(definition.id) &&
            definition.transport === "stdio" &&
            cliSupport(account.tool, definition).supported,
        );
      let next = launch;
      for (const grant of stdioGrants(definitions, { pathEnv: launch.env?.PATH ?? "" }))
        next = addGrant(next, grant);
      return next;
    } catch (error) {
      this.warn(`MCP sandbox grants for ${account.tool} are missing (${codeOf(error)}).`);
      return launch;
    }
  }
}
