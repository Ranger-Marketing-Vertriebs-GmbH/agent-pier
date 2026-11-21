import fs from "node:fs";
import path from "node:path";
import { relocatePaths } from "../../../../lib/relocate-paths.js";
import { writePrivate } from "../../../../lib/storage.js";

// openclaw.json and the copies OpenClaw keeps beside it (`.bak` … `.last-good`), and
// OpenClaw's per-agent session index, whose entries may name transcripts by absolute
// path: the same files a backup stores relative to its root (assistant-backup-paths.js).
const configCopy = /^openclaw\.json(\.[^/]+)?$/;
function stateFiles(paths) {
  const files = [];
  const list = (directory) => {
    try {
      return fs.readdirSync(directory).sort();
    } catch {
      return [];
    }
  };
  for (const name of list(paths.state))
    if (configCopy.test(name)) files.push(path.join(paths.state, name));
  const agents = path.join(paths.state, "agents");
  for (const agent of list(agents)) {
    const index = path.join(agents, agent, "sessions", "sessions.json");
    if (fs.existsSync(index)) files.push(index);
  }
  return files;
}

/**
 * The assistants folder the Gateway's state was last written for. AgentPier compiles
 * `agents.defaults.workspace` as `<assistants>/workspaces` on every start (and a
 * restore resolves it to its target), so it names the folder all other paths in the
 * state were written below.
 */
export function recordedRoot(config) {
  const workspace = config?.agents?.defaults?.workspace;
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return null;
  const normalized = path.normalize(workspace).replace(/\/+$/, "");
  return path.basename(normalized) === "workspaces" ? path.dirname(normalized) : null;
}

// The assistants folder an agent entry's workspace (`<root>/workspaces/<id>`) or
// agentDir (`<root>/state/agents/<id>/agent`) was written below; null otherwise.
function entryRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  const normalized = path.normalize(value).replace(/\/+$/, "");
  const match =
    /^(.+)\/workspaces(?:\/[^/]+)?$/.exec(normalized) ||
    /^(.+)\/state\/agents\/[^/]+\/agent$/.exec(normalized);
  return match ? match[1] : null;
}

/**
 * Every assistants folder the Gateway's state names: the defaults' one and each agent
 * entry's. A start with an older AgentPier after a move rewrote the defaults but kept
 * the entries, so the entries can name the old folder alone.
 */
export function recordedRoots(config) {
  const roots = new Set();
  const root = recordedRoot(config);
  if (root) roots.add(root);
  for (const entry of Object.values(config?.agents?.entries ?? {}))
    for (const value of [entry?.workspace, entry?.agentDir]) {
      const found = entryRoot(value);
      if (found) roots.add(found);
    }
  return [...roots];
}

/**
 * A data directory restored into one folder and started from another (moved, copied
 * or restored elsewhere) keeps the first folder's absolute paths in the Gateway's
 * state: its agents would work in, and OpenClaw would recreate, the old folder
 * (AGENTPIER-467). Before a Gateway start this rewrites every path below each recorded
 * assistants folder to this start's one. Returns the folders it moved from.
 */
export function relocateRuntimeState(paths, config) {
  const to = path.resolve(paths.root);
  const from = recordedRoots(config).filter((root) => root !== to);
  if (!from.length) return [];
  for (const file of stateFiles(paths)) {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // An unfinished atomic-write temporary: OpenClaw never reads it back.
      continue;
    }
    let moved = false;
    let next = value;
    for (const root of from) next = relocatePaths(next, root, to, () => (moved = true));
    if (moved) writePrivate(file, next);
  }
  return from;
}

/**
 * The assistants folder an earlier data directory had in place of `root`, when `file`
 * names an installation below its `runtimes` folder; null for a path below `root`
 * itself or any other value.
 */
export function recordedRootOf(file, root) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  const resolved = path.resolve(file);
  if (resolved.startsWith(root + path.sep)) return null;
  const name = path.basename(root);
  const at = resolved.indexOf(`${path.sep}${name}${path.sep}runtimes${path.sep}`);
  return at < 0 ? null : resolved.slice(0, at + name.length + 1);
}

function strings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) strings(item, found);
  return found;
}

/**
 * The selection, the staged candidate and the update journal name the installation
 * by absolute path (runtime-install.js). In a data directory restored, moved or
 * copied elsewhere they point at this one's `runtimes` folder before they are read;
 * the Node.js runtime and its packages run from any folder.
 */
export function relocateRuntimeRecords(paths) {
  const root = path.resolve(paths.root);
  for (const name of ["runtime.json", "candidate.json", "update.json"]) {
    const file = path.join(root, name);
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const from = strings(value)
      .map((text) => recordedRootOf(text, root))
      .find(Boolean);
    if (from) writePrivate(file, relocatePaths(value, from, root));
  }
}
