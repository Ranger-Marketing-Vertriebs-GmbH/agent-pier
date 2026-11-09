import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { logCraftFailure } from "./craft-log.js";
import { craftEnvironment, rebuildsConfigDir } from "../tools/craft-config.js";
import { craftCommand } from "../tools/craft-row.js";
import { RebuildProcesses } from "./rebuild-processes.js";

const messages = serverMessages.craft;
const tool = "craft-anything";
const READY_WAIT_MS = 1000;

/** The arguments of a rebuild child: every tool, AgentPier's own consent, the mode. */
export const rebuildArgs = (mode) => [
  "mcp",
  "--all-tools",
  "--allow-run",
  mode === "deep" ? "--deep" : "--clean-room",
];

/**
 * The supervisor's `craft-anything-cli mcp` children, one per account and mode: each
 * runs with that account's environment (its CLAUDE_CONFIG_DIR selects the account the
 * builder bills to) and the rebuilds' own config directory. A child closes `idleMs`
 * after the last of its rebuilds stopped running and no call uses it. `running(key)`
 * tells whether a rebuild of that child runs; `lost(key)` hears an unexpected exit.
 */
export class RebuildChildren {
  constructor({
    dataDir,
    craft,
    accounts,
    clientFactory,
    timers,
    idleMs,
    running,
    lost,
  }) {
    Object.assign(this, { dataDir, craft, accounts, clientFactory, timers, idleMs });
    this.running = running;
    this.lost = lost;
    this.entries = new Map(); // key → { ready, client, spawned, busy, idle }
    // The children's process groups, kept across a crash (rebuild-processes.js).
    this.processes = new RebuildProcesses(dataDir);
    this.closing = false;
  }

  /** How many children run or start. */
  get size() {
    return this.entries.size;
  }

  key(accountId, mode) {
    return `${accountId}\n${mode}`;
  }

  /** The live client of `accountId` and `mode`, without starting one. */
  peek(accountId, mode) {
    const client = this.entries.get(this.key(accountId, mode))?.client;
    return client?.alive ? client : null;
  }

  /** Runs `work(client)` on the child of `accountId` and `mode`, started if needed. */
  async use(accountId, mode, work) {
    if (this.closing) throw problem(messages.rebuildsStopping, 409);
    const key = this.key(accountId, mode);
    let entry = this.entries.get(key);
    if (entry?.client && !entry.client.alive) entry = null;
    if (!entry) {
      entry = { ready: null, client: null, busy: 0, idle: null };
      entry.ready = this.spawn(key, accountId, mode, entry);
      this.entries.set(key, entry);
      entry.ready.catch(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
    }
    entry.busy += 1;
    this.disarm(entry);
    try {
      return await work(await entry.ready);
    } finally {
      entry.busy -= 1;
      this.settle(accountId, mode);
    }
  }

  async spawn(key, accountId, mode, entry) {
    const component = this.craft.component(tool);
    if (!component) throw problem(messages.notInstalled, 409);
    const configDir = rebuildsConfigDir(this.dataDir);
    this.craft.writeConfig(undefined, configDir, { builder: true });
    const env = {
      ...this.accounts.environment(accountId),
      ...craftEnvironment(this.dataDir),
      CRAFT_ANYTHING_CONFIG_DIR: configDir,
    };
    let client;
    try {
      client = await this.clientFactory({
        command: craftCommand(this.craft.root, component),
        args: rebuildArgs(mode),
        env,
        cwd: configDir,
        onSpawn: (spawned) => (entry.spawned = spawned),
        track: this.processes,
      });
    } catch (error) {
      throw problem(messages.rebuildUnavailable(error.message), 409);
    }
    entry.client = client;
    client.onExit((event) => {
      if (event.expected) return;
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.disarm(entry);
      // close() awaits the kill of the builders the child left behind.
      client
        .close()
        .catch((error) => logCraftFailure("close a Craft Anything child", error));
      this.lost(key);
    });
    if (this.closing) {
      await client.close();
      throw problem(messages.rebuildsStopping, 409);
    }
    return client;
  }

  /** Server start: ends what the previous server's children left running. */
  reap() {
    return this.processes.reap();
  }

  /** Arms the idle close while nothing of the child runs or calls; disarms it else. */
  settle(accountId, mode) {
    const key = this.key(accountId, mode);
    const entry = this.entries.get(key);
    if (!entry || this.closing) return;
    if (entry.busy || this.running(key)) return this.disarm(entry);
    if (entry.idle) return;
    entry.idle = this.timers.setTimeout(() => {
      entry.idle = null;
      if (this.entries.get(key) !== entry || entry.busy || this.running(key)) return;
      this.entries.delete(key);
      entry.ready
        .then((client) => client.close())
        .catch((error) => logCraftFailure("close an idle Craft Anything child", error));
    }, this.idleMs);
  }

  /**
   * Closes every child no running rebuild uses (one a view opened, one waiting for its
   * idle close) through the usual close; resolves once they are gone.
   */
  async closeIdle() {
    const idle = [...this.entries].filter(([key]) => !this.running(key));
    for (const [key, entry] of idle) {
      this.entries.delete(key);
      this.disarm(entry);
    }
    await Promise.all(
      idle.map(([, entry]) =>
        entry.ready
          .then((client) => client.close())
          .catch((error) => logCraftFailure("close an idle Craft Anything child", error)),
      ),
    );
  }

  disarm(entry) {
    if (!entry.idle) return;
    this.timers.clearTimeout(entry.idle);
    entry.idle = null;
  }

  /**
   * Closes every child: `stopProjects(key)` names the projects to stop first (the
   * builders end with them); the child then exits and its descendants are killed.
   */
  async close(stopProjects) {
    this.closing = true;
    const entries = [...this.entries];
    this.entries.clear();
    await Promise.all(
      entries.map(async ([key, entry]) => {
        this.disarm(entry);
        // A child still initializing gets READY_WAIT_MS, then its group is killed:
        // close() must end well inside the forced exit (server/index.js, 6 s).
        const late = {};
        let timer;
        const client = await Promise.race([
          entry.ready.catch(() => null),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(() => resolve(late), READY_WAIT_MS);
          }),
        ]);
        this.timers.clearTimeout(timer);
        if (client === late) return entry.spawned?.close();
        await client?.close({ stopProjects: stopProjects(key) });
      }),
    );
  }
}
