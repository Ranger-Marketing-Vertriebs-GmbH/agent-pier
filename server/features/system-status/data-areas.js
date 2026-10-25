import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

export const AREAS = [
  "profiles",
  "clis",
  "tools",
  "runtimes",
  "backups",
  "chatAttachments",
  "agentAttachments",
  "agentShares",
  "agentWorkspaces",
  "secrets",
  "logs",
  "other",
];
const top = {
  profiles: "profiles",
  clis: "clis",
  toolchains: "tools",
  "mcp-packages": "tools",
  "chat-attachments": "chatAttachments",
  secrets: "secrets",
  "server.log": "logs",
  "server-error.log": "logs",
};
const agentTop = {
  backups: "backups",
  shares: "agentShares",
  runtimes: "runtimes",
  logs: "logs",
};

/**
 * The area of a data-directory-relative path, or null for a folder whose entries
 * belong to different areas (the root, `operations`, `assistants` and the agent
 * workspaces, which hold each agent's attachments next to its other files).
 */
export function areaOf(parts, directory) {
  const [first, second, third, fourth] = parts;
  if (first === undefined) return directory ? null : "other";
  if (top[first]) return top[first];
  if (first === "operations") {
    if (second === undefined) return directory ? null : "other";
    return ["backups", "restores"].includes(second) ? "backups" : "other";
  }
  if (first !== "assistants") return "other";
  if (second === undefined) return directory ? null : "other";
  if (agentTop[second]) return agentTop[second];
  if (second !== "workspaces") return "other";
  if (third === undefined || fourth === undefined)
    return directory ? null : "agentWorkspaces";
  return fourth === "attachments" ? "agentAttachments" : "agentWorkspaces";
}

/**
 * Sizes the data directory by area. The walk never follows symbolic links, stays on
 * the data directory's file system, counts a hard-linked file once and stops after
 * `maxEntries` entries or `budgetMs`, returning what it has counted as partial.
 */
export async function measureDataAreas(
  dataDir,
  {
    maxEntries = 1_000_000,
    budgetMs = 120_000,
    now = Date.now,
    batch = 64,
    stat = lstat,
    open = opendir,
    stopped = () => false,
  } = {},
) {
  const started = now();
  const bytes = Object.fromEntries(AREAS.map((id) => [id, 0]));
  const root = await stat(dataDir);
  const links = new Set();
  const stack = [{ directory: dataDir, parts: [], area: null }];
  let entries = 0,
    partial = false;
  const count = (info, area) => {
    if (info.nlink > 1 && !info.isDirectory()) {
      const key = `${info.dev}:${info.ino}`;
      if (links.has(key)) return;
      if (links.size < 200_000) links.add(key);
    }
    bytes[area] += Number.isFinite(info.blocks) ? info.blocks * 512 : info.size;
  };
  walk: while (stack.length) {
    const { directory, parts, area } = stack.pop();
    let handle;
    try {
      handle = await open(directory);
    } catch {
      continue; // A folder removed or locked during the walk is skipped.
    }
    let pending = [];
    const flush = async () => {
      const results = await Promise.all(
        pending.map(async (name) => {
          try {
            return [name, await stat(path.join(directory, name))];
          } catch {
            return [name, null];
          }
        }),
      );
      pending = [];
      for (const [name, info] of results) {
        if (!info) continue;
        const childParts = [...parts, name];
        const isDirectory = info.isDirectory();
        const childArea = area ?? areaOf(childParts, isDirectory);
        if (isDirectory) {
          count(info, childArea ?? "other");
          if (info.dev === root.dev)
            stack.push({
              directory: path.join(directory, name),
              parts: childParts,
              area: childArea,
            });
        } else count(info, childArea ?? "other");
      }
    };
    try {
      for (let entry = await handle.read(); entry; entry = await handle.read()) {
        if (++entries > maxEntries || now() - started > budgetMs || stopped()) {
          partial = true;
          break;
        }
        pending.push(entry.name);
        if (pending.length >= batch) await flush();
      }
      await flush();
    } catch {
      // An unreadable folder contributes what was counted before the error.
    } finally {
      try {
        await handle.close();
      } catch {
        // Closing a handle that failed mid-read has nothing left to release.
      }
    }
    if (partial) break walk;
    // Yield so the walk never holds the event loop for a large tree.
    await new Promise((resolve) => setImmediate(resolve));
  }
  const areas = AREAS.map((id) => ({ id, bytes: bytes[id] }))
    .filter((item) => item.bytes > 0)
    .sort((a, b) => (a.id === "other") - (b.id === "other") || b.bytes - a.bytes);
  return {
    computedAt: new Date(now()).toISOString(),
    durationMs: now() - started,
    partial,
    totalBytes: areas.reduce((sum, item) => sum + item.bytes, 0),
    areas,
  };
}
