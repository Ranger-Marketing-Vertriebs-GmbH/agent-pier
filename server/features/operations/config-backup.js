import fs from "node:fs";
import path from "node:path";
import { readJson } from "./files.js";
import { readFileLimits } from "../files/file-limits.js";
import { normalizeNetworkConfig } from "../../lib/network-config.js";

/**
 * How `config.json` travels through a backup (docs/backups.md, "Settings in
 * config.json"). Host-independent settings come back as saved. Host-bound ones
 * describe how this machine is reached: they come from the instance that runs the
 * restore, so the address the owner used keeps working, and from the backup only when
 * it was made on this same machine. The backup keeps the host-bound ones under
 * `backupHost`, which earlier AgentPier versions ignore.
 */
export const hostIndependentSettings = ["pipelines", "previews", "ticketRules", "files"];
export const hostBoundSettings = ["remoteUrl", "ownerLogin", "network"];
const BACKUP_HOST = "backupHost";

const plainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The value of `key` as AgentPier would start with it, or undefined when unusable. */
function usable(key, value) {
  if (value === undefined || value === null) return undefined;
  try {
    switch (key) {
      case "port":
        return Number.isInteger(value) && value >= 1 && value <= 65535
          ? value
          : undefined;
      case "remoteUrl": {
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol) ? value : undefined;
      }
      case "ownerLogin":
        return typeof value === "string" && value.trim() ? value : undefined;
      case "network": {
        const network = normalizeNetworkConfig(value);
        // A disabled network mode is the default: nothing to carry over.
        return network.enabled || network.hosts.length ? network : undefined;
      }
      case "files":
        if (!plainObject(value) || value.limits === undefined) return undefined;
        readFileLimits(value.limits);
        return { limits: value.limits };
      default:
        return plainObject(value) ? value : undefined;
    }
  } catch {
    return undefined;
  }
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    const value = usable(key, source?.[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** The archived `config.json`: known settings only, host-bound ones with the host. */
export function captureConfig(saved, hostId) {
  if (!plainObject(saved)) return {};
  const bound = pick(saved, hostBoundSettings);
  return {
    ...pick(saved, ["port", ...hostIndependentSettings]),
    [BACKUP_HOST]: { id: hostId || null, ...bound },
  };
}

/**
 * Rewrites the staged `config.json` for this host: `liveDataDir` is the instance
 * running the restore, `hostId` this machine's fingerprint. Returns the report part.
 */
export function restoreConfig(stage, { liveDataDir, hostId }) {
  const file = path.join(stage, "config.json");
  let archived;
  try {
    archived = readJson(file, undefined);
  } catch {
    archived = null; // A malformed archived config.json restores nothing of it.
  }
  const backup = plainObject(archived) ? archived : {};
  const host = plainObject(backup[BACKUP_HOST]) ? backup[BACKUP_HOST] : {};
  let live = {};
  try {
    const own = readJson(path.join(liveDataDir, "config.json"), {});
    if (plainObject(own)) live = own;
  } catch {
    // An unreadable live config.json carries nothing over.
  }
  const sameHost = Boolean(hostId && host.id === hostId);
  const next = pick(backup, hostIndependentSettings);
  const restored = Object.keys(next),
    fromThisInstance = [],
    setAgain = [];
  // The port is the address itself: always this instance's, never the backup's.
  const port = usable("port", live.port);
  if (port !== undefined) {
    next.port = port;
    fromThisInstance.push("port");
  }
  for (const key of hostBoundSettings) {
    const own = usable(key, live[key]),
      archivedValue = usable(key, host[key]);
    if (own !== undefined) {
      next[key] = own;
      fromThisInstance.push(key);
    } else if (sameHost && archivedValue !== undefined) {
      next[key] = archivedValue;
      restored.push(key);
    } else if (archivedValue !== undefined) setAgain.push(key);
  }
  if (archived !== undefined || Object.keys(next).length) {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }
  return { sameHost, restored, fromThisInstance, setAgain };
}
