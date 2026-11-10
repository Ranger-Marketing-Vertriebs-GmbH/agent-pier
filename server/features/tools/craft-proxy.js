import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivate } from "../../lib/storage.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { craftHome } from "./craft-home.js";

// Craft Anything's session row runs AgentPier's swap proxy (mcp-swap-proxy.js), which
// starts the server named in the spec file and swaps it in running sessions when the
// spec changes (an update, a mode change). Each proxy keeps a status file.

export const proxyMain = fileURLToPath(
  new URL("./mcp-swap-proxy-main.js", import.meta.url),
);
/** The spec the proxies follow: `{ command, args, statusDir }`. */
export const proxySpecFile = (dataDir) => path.join(craftHome(dataDir), "server.json");
/** One `<pid>.json` per running proxy: `{ pid, command, args, error }`. */
export const proxyStatusDir = (dataDir) => path.join(craftHome(dataDir), "proxies");

/**
 * Points the proxies at `server` ({ command, args }) and returns what the row runs:
 * the proxy under `node` with the spec file. The spec is rewritten only when it
 * changed, so an unchanged server never swaps.
 */
export function craftProxyRow(dataDir, server, node = process.execPath) {
  const file = proxySpecFile(dataDir);
  const spec = { ...server, statusDir: proxyStatusDir(dataDir) };
  let current = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {}
  if (current !== JSON.stringify(spec, null, 2) + "\n") writePrivate(file, spec);
  return { command: node, args: [proxyMain, file] };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * The running proxies' statuses; the files of proxies that are gone are removed.
 * Returns `[{ pid, command, args, error }]`.
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
      if (status?.pid === pid) statuses.push(status);
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
