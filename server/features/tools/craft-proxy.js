import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writePrivate } from "../../lib/storage.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { craftEnvironment } from "./craft-config.js";
import { craftHome } from "./craft-home.js";
import { craftArgs, craftCommand } from "./craft-row.js";

// Craft Anything's session row runs AgentPier's swap proxy (mcp-swap-proxy.js) with
// the owner's mode. The proxy starts the server named in the spec file and swaps it
// in running sessions when its command changes (another version); a mode change
// reaches new sessions only. Each proxy keeps a status file.

export const proxyMain = fileURLToPath(
  new URL("./mcp-swap-proxy-main.js", import.meta.url),
);
/** The spec the proxies follow: `{ command, variants, env, statusDir }`. */
export const proxySpecFile = (dataDir) => path.join(craftHome(dataDir), "server.json");
/** One `<pid>.json` per running proxy: `{ pid, command, error }`. */
export const proxyStatusDir = (dataDir) => path.join(craftHome(dataDir), "proxies");

/**
 * Points the proxies at `server` (`{ command, variants: { <name>: args }, env }`) and
 * returns the row's command and args: the proxy under `node` with the spec file and
 * `variant`. The spec is rewritten only when it changed.
 */
export function craftProxyRow(dataDir, server, node, variant) {
  const file = proxySpecFile(dataDir);
  const spec = { ...server, statusDir: proxyStatusDir(dataDir) };
  let current = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {}
  if (current !== JSON.stringify(spec, null, 2) + "\n") writePrivate(file, spec);
  return { command: node, args: [proxyMain, file, variant] };
}

/** The session row of CraftTool `craft` for installed `component` and `settings`. */
export function craftSessionRow(craft, component, settings) {
  const env = craftEnvironment(craft.dataDir);
  const server = {
    command: craftCommand(craft.root, component),
    variants: {
      "clean-room": craftArgs({ mode: "clean-room" }),
      deep: craftArgs({ mode: "deep" }),
    },
    env,
  };
  return { ...craftProxyRow(craft.dataDir, server, craft.node, settings.mode), env };
}

// Same user only: EPERM means another user's process under a reused pid.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A failed swap is shown only while that pid still is one of our proxies.
const isProxy = (pid) => {
  try {
    return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1500,
    }).includes(proxyMain);
  } catch {
    return false;
  }
};

/**
 * The running proxies' statuses; the files of proxies that are gone are removed.
 * Returns `[{ pid, command, error }]`.
 */
export function craftProxies(dataDir) {
  const directory = proxyStatusDir(dataDir);
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const statuses = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const pid = Number(name.slice(0, -".json".length));
    if (!alive(pid)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    try {
      const status = JSON.parse(fs.readFileSync(file, "utf8"));
      if (status?.pid !== pid || (status.error && !isProxy(pid))) continue;
      statuses.push(status);
    } catch {}
  }
  return statuses;
}

/**
 * Calls `onChange()` (debounced) whenever a proxy starts, swaps, fails or ends.
 * Returns a function that stops watching. Never throws.
 */
export function watchCraftProxies(dataDir, onChange, delayMs = 500) {
  let timer = null;
  let watcher = null;
  try {
    const directory = proxyStatusDir(dataDir);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    watcher = fs.watch(directory, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          onChange();
        } catch (error) {
          logFailure("follow Craft Anything's sessions", error);
        }
      }, delayMs);
      timer.unref?.();
    });
    watcher.on("error", () => watcher?.close());
    watcher.unref?.();
  } catch (error) {
    logFailure("watch Craft Anything's sessions", error);
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}

/**
 * CraftTool `craft` follows its proxies while installed: the dialog updates and the
 * old version folder goes once a swapped server exited.
 */
export function followProxies(craft) {
  craft.unwatch?.();
  craft.unwatch = null;
  if (!craft.installed()) return;
  craft.unwatch = watchCraftProxies(craft.dataDir, () => {
    craft.changed();
    void craft.versions.run();
  });
}
