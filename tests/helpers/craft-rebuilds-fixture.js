import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CraftMcpClient } from "../../server/features/craft/craft-mcp-client.js";
import { CraftRebuilds } from "../../server/features/craft/craft-rebuilds.js";
import { Preferences } from "../../server/features/settings/preferences.js";
import {
  ensureGhidraStub,
  writeCraftConfig,
} from "../../server/features/tools/craft-config.js";

const fakeServer = path.resolve(import.meta.dirname, "fake-craft-mcp.mjs");

/** Whether a process exists (a zombie counts; wait with `until`). */
export const exists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** A clock whose timeouts run only when the test advances it. */
export function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= target);
        if (!due.length) break;
        const [id, timer] = due.sort((a, b) => a[1].at - b[1].at)[0];
        pending.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    get size() {
      return pending.size;
    },
  };
}

/** Claude accounts: two of the owner's own, and one that may not build. */
export const testAccounts = [
  { id: "local-claude", tool: "claude", kind: "local", name: "Local" },
  { id: "acc-a", tool: "claude", kind: "managed", name: "A" },
  { id: "acc-b", tool: "claude", kind: "managed", name: "B" },
  { id: "acc-provider", tool: "claude", kind: "managed", name: "P", provider: "x" },
];

/**
 * A CraftRebuilds over the fake Craft Anything MCP server, a disposable data and
 * projects folder, a project memory double and the accounts above. Each managed
 * account's environment points CLAUDE_CONFIG_DIR at its own profile folder.
 */
/**
 * `intercept(name, args)` runs before every client call and may throw to fail it.
 */
export function rebuildsFixture(
  t,
  { script, installed = true, intercept, ...options } = {},
) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "craft-rebuilds-")));
  const dataDir = path.join(dir, "data");
  const projectsDir = path.join(dir, "projects");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(projectsDir);
  fs.writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ defaultCwd: projectsDir }),
  );
  const projects = [];
  const memory = {
    claimsFolder: () => false,
    projectNames: () => projects.map((p) => ({ id: p.id })),
    register: async (cwd) => {
      const project = { id: `p${projects.length + 1}`, cwd, name: path.basename(cwd) };
      projects.push(project);
      return project;
    },
    removeEmpty: (id) =>
      projects.splice(
        projects.findIndex((p) => p.id === id),
        1,
      ),
  };
  const profile = (id) => path.join(dir, "profiles", id);
  const accounts = {
    list: () => testAccounts,
    environment: (id) => {
      const env = { ...process.env };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      if (id === "local-claude") return env;
      return {
        ...env,
        CLAUDE_CONFIG_DIR: profile(id),
        CLAUDE_SECURESTORAGE_CONFIG_DIR: profile(id),
      };
    },
  };
  const preferences = new Preferences({ dataDir, home: projectsDir, accounts });
  const component = {
    directory: path.join(dir, "clis", "craft-anything", "0.5.0"),
    home: path.join(dir, "clis", "craft-anything", "0.5.0"),
    version: "0.5.0",
  };
  const craft = {
    root: path.join(dir, "clis"),
    state: () => ({ installed }),
    component: (id) => (id === "craft-anything" && installed ? component : null),
    writeConfig: (_components, configDir, { builder } = {}) =>
      writeCraftConfig(configDir, {
        ghidra: null,
        jdk: null,
        stub: ensureGhidraStub(dataDir),
        builder,
      }),
  };
  const spawned = [];
  const clients = [];
  const clientFactory = async (spawnOptions) => {
    spawned.push(spawnOptions);
    const client = await CraftMcpClient.start({
      ...spawnOptions,
      command: process.execPath,
      args: [fakeServer, ...spawnOptions.args],
      env: {
        ...spawnOptions.env,
        ...(script && { FAKE_CRAFT_SCRIPT: JSON.stringify(script) }),
      },
    });
    if (intercept) {
      const call = client.call.bind(client);
      client.call = async (name, args, callOptions) => {
        await intercept(name, args);
        return call(name, args, callOptions);
      };
    }
    clients.push(client);
    return client;
  };
  const instances = [];
  const create = (extra = {}) => {
    const rebuilds = new CraftRebuilds({
      dataDir,
      craft,
      accounts,
      preferences,
      memory,
      clientFactory,
      sampleMs: 50,
      ...options,
      ...extra,
    });
    instances.push(rebuilds);
    return rebuilds;
  };
  t.after(async () => {
    for (const rebuilds of instances) await rebuilds.close().catch(() => {});
    for (const client of clients) await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** The fake's project record in a rebuild's folder. */
  const craftRecord = (view) =>
    JSON.parse(fs.readFileSync(path.join(view.folder, "craft.json"), "utf8"));
  return {
    dir,
    dataDir,
    projectsDir,
    projects,
    profile,
    spawned,
    clients,
    create,
    rebuilds: create(),
    craftRecord,
  };
}
