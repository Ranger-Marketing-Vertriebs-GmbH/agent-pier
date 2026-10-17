import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentProfileName } from "../assistants/openclaw-config/browser-profiles.js";
import { sqliteSnapshotFileAsync } from "./snapshot.js";
import { areaComponent, ensureSpace } from "./backup-components.js";

/**
 * The agents' own browser profiles (agent-browsers.js) hold their logins and cookies.
 * Host backups carry them only with a passphrase, sealed like histories
 * (history-seal.js), and never their caches; member slots and OpenClaw's own default
 * profile are never backed up. Without a passphrase they are left out.
 */
export const browserProfilesOmission =
  "Agent browser profiles (only in backups with a passphrase, then encrypted)";
export const browserCachesOmission = "Agent browser caches";
export const browserUnreadableOmission = "Agent browser files that were in use";
export const browserAgentsUnreadableOmission =
  "Agent browser profiles (the agent list could not be read)";
export const browserProfilesComponent = "sealed-agent-browser-profiles";
const prefix = "assistants/state/browser";
const browserPath = /^assistants\/state\/browser\/agent-[a-z0-9-]{1,58}\/user-data\/.+$/;
/** Whether `name` is an agent browser profile file, which backups archive only sealed. */
export const isBrowserProfilePath = (name) => browserPath.test(name);
// Chromium's caches and per-process files; Singleton* are links and never followed.
const skipped = /(^|\/)([^/]*cache|Crashpad|BrowserMetrics|Singleton[^/]*)(\/|$)/i;
const volatile = /-(wal|shm|journal)$|\.lock$|\.tmp$/;
const sqliteHeader = Buffer.from("SQLite format 3\0");

function isSqlite(file) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(16);
    fs.readSync(handle, head, 0, 16, 0);
    return head.equals(sqliteHeader);
  } finally {
    fs.closeSync(handle);
  }
}

/** The ids of the agents assistants.sqlite holds, archived ones included; null when unreadable. */
export function storedAgentIds(dataDir) {
  let db;
  try {
    db = new DatabaseSync(path.join(dataDir, "assistants", "assistants.sqlite"), {
      readOnly: true,
    });
    return new Set(
      db
        .prepare("SELECT id FROM assistants")
        .all()
        .map((row) => row.id),
    );
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
/**
 * Sealed history members for the profile of every agent that still exists; a
 * profile left behind by a removed agent is not archived.
 */
export async function captureBrowserProfiles({
  dataDir,
  plan,
  scratch,
  agents = storedAgentIds(dataDir),
}) {
  // Without the agent list no profile can be attributed: all are left out, visibly.
  if (!agents)
    return { files: [], captures: [], omissions: [browserAgentsUnreadableOmission] };
  const owned = new Set([...agents].map(agentProfileName).filter(Boolean));
  const root = path.join(dataDir, prefix);
  const component = areaComponent("assistants");
  const result = { files: [], captures: [], omissions: [] };
  let unreadable = false;
  const visit = async (directory, relative) => {
    let names;
    try {
      names = fs.readdirSync(directory).sort();
    } catch {
      unreadable = true;
      return;
    }
    for (const name of names) {
      const next = `${relative}/${name}`;
      if (skipped.test(name) || volatile.test(name)) continue;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await visit(file, next);
        continue;
      }
      const member = `${prefix}/${next}`;
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        !isBrowserProfilePath(member)
      ) {
        unreadable = true;
        continue;
      }
      try {
        if (stat.size >= 16 && isSqlite(file)) {
          // A database the running browser holds is copied consistently, or skipped.
          ensureSpace(scratch, stat.size);
          const copy = await sqliteSnapshotFileAsync(file, scratch);
          result.files.push({
            path: member,
            file: copy,
            size: fs.statSync(copy).size,
            component,
            history: true,
            temporary: true,
          });
        } else {
          const planned = plan.file(member, file, component, stat);
          if (planned) result.files.push({ ...planned, history: true });
        }
      } catch {
        unreadable = true;
      }
    }
  };
  let profiles = [];
  try {
    profiles = fs.readdirSync(root).sort();
  } catch {
    /* No browser yet. */
  }
  for (const name of profiles) {
    const userData = path.join(root, name, "user-data");
    const stat = fs.lstatSync(userData, { throwIfNoEntry: false });
    if (/^agent-[a-z0-9-]{1,58}$/.test(name) && owned.has(name) && stat?.isDirectory())
      await visit(userData, `${name}/user-data`);
  }
  if (unreadable) result.omissions.push(browserUnreadableOmission);
  return result;
}
