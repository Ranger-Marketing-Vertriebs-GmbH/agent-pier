import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import {
  assistantStorageProblem,
  readAssistantFeature,
} from "../assistants/assistant-feature.js";
import { needsAssistantMaintenance } from "../assistants/assistant-maintenance.js";
import {
  configPath,
  createBackupKey,
  destroyBackupKey,
  isCredentialFile,
  readBackupKey,
  seal,
  sealConfig,
  sealDatabase,
  sealedSuffix,
  unseal,
  unsealConfig,
  unsealDatabase,
} from "../assistants/backup-credentials.js";
import { folder, readFile, relativeName } from "./files.js";
import { isRelocatable, portableText, restoredText } from "./assistant-backup-paths.js";
import { fileMember, sqliteSnapshot } from "./snapshot.js";

/**
 * Host backups carry the assistant folder except what is installed, cached, derived
 * or bound to this host's live processes and paths. Credentials never leave in plain
 * text: with credentials (and the feature on) they are sealed under a per-backup key
 * that stays in the live private store (assistants/backup-keys) and is destroyed by
 * every logout or revocation; otherwise they are left out entirely.
 */
const prefix = "assistants";
const excludedFolders = new Set([
  // Gateway logs are diagnostics that grow without bound; they never block a backup.
  "logs",
  "runtimes",
  "npm-cache",
  "tmp",
  "backups",
  "tls",
  "backup-keys",
]);
const excludedFiles = new Set([
  // Live process ownership and the loopback webhook secret are regenerated on start.
  "owner.json",
  "reminder-webhook.json",
  // Runtime selection and update state name this host's runtimes/ and backups/ by
  // absolute path. Without them a restored instance installs its runtime again.
  "runtime.json",
  "candidate.json",
  "update.json",
  "runtime-maintenance.json",
]);
// Caches of the Gateway's own trees; workspaces belong to the user and stay complete.
const volatileTree = /(^|\/)(cache|node_modules)(\/|$)/;
const volatile = /-(wal|shm|journal)$|\.lock$|\.tmp$/;
const sqliteHeader = Buffer.from("SQLite format 3\0");
// Base64 grows members by a third; this keeps the archive below its 256 MiB limit.
const memberLimit = 128 * 1024 * 1024;
export const assistantOmissions = [
  "Assistant runtimes, package caches, update snapshots, TLS and backup keys",
  "Speech connection (Deepgram key and settings)",
];
const unsafeOmission = "Assistant data in unsafe storage";
const workspaceOmission = "Agent workspaces too large";
const unfinishedOmission = "Agent data skipped: unfinished update state";
const tooLargeOmission = "Agent data too large";
const unreadableOmission = "Unreadable agent runtime files";
// Thrown when non-workspace agent data exceeds the budget: the whole component is
// left out, because a partial agent ledger cannot be restored consistently.
const overflow = Symbol("assistant backup overflow");
const omitted = (omission) => ({
  files: [],
  captures: [],
  omissions: [omission],
  manifest: null,
});

const included = (relative) => {
  const [top] = relative.split("/");
  return (
    !excludedFolders.has(top) &&
    !excludedFiles.has(relative) &&
    !volatile.test(relative) &&
    (top === "workspaces" || !volatileTree.test(relative))
  );
};
/** True for an archive member path a host backup may restore into assistants/. */
export function isAssistantMember(name) {
  if (typeof name !== "string" || !name.startsWith(`${prefix}/`)) return false;
  try {
    relativeName(name);
  } catch {
    return false;
  }
  const relative = name.slice(prefix.length + 1);
  return included(
    relative.endsWith(sealedSuffix) ? relative.slice(0, -sealedSuffix.length) : relative,
  );
}
const assistantsPresent = (dataDir) => fs.existsSync(path.join(dataDir, prefix));
/** True when a host backup will carry assistant data. Never creates the folder. */
export function assistantsCaptured(dataDir) {
  return assistantsPresent(dataDir) && !assistantStorageProblem(dataDir);
}
function sealedTree(relative) {
  const [top] = relative.split("/");
  return !relative.includes("/") || top === "home" || top === "state";
}
function isSqlite(bytes) {
  return bytes.subarray(0, 16).equals(sqliteHeader);
}
/** Captures assistants/ for backup `id`; returns null when the feature never stored data. */
export async function captureAssistants({
  dataDir,
  id,
  withCredentials,
  limit = memberLimit,
  busy = () => false,
}) {
  if (!assistantsPresent(dataDir)) return null;
  if (assistantStorageProblem(dataDir)) return omitted(unsafeOmission);
  const root = path.join(dataDir, prefix);
  // A running update or provider change is waited for; state an update left behind
  // (a crash, a failed recovery, a dormant install) only skips the agents' data.
  if (readAssistantFeature(dataDir).enabled && busy())
    throw problem(serverMessages.backups.assistantsBusy, 409);
  if (needsAssistantMaintenance({ root })) return omitted(unfinishedOmission);
  const startedAt = new Date().toISOString();
  // Only a running feature can revoke keys, so only then may credentials be sealed.
  const sealing = withCredentials && readAssistantFeature(dataDir).enabled;
  const key = sealing ? await createBackupKey(root, id) : randomBytes(32);
  // Work files stay outside assistants/, which a dormant install must not grow.
  const work = folder(path.join(dataDir, "operations", `.snapshot-${randomUUID()}`));
  const files = [],
    workspaces = [],
    sealed = [];
  let bytes = 0,
    workspaceBytes = 0,
    withheld = false,
    oversize = false,
    unreadable = false,
    skipped = 0;
  const add = (relative, content) => {
    const member = fileMember(`${prefix}/${relative}`, content);
    if (relative.startsWith("workspaces/")) {
      workspaceBytes += content.length;
      return workspaces.push(member);
    }
    bytes += content.length;
    if (bytes > limit || files.length >= 20000) throw overflow;
    files.push(member);
  };
  async function entry(source, relative) {
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(source).sort()) {
        const next = `${relative ? `${relative}/` : ""}${name}`;
        if (included(next) && !name.endsWith(sealedSuffix))
          await entry(path.join(source, name), next);
      }
      return;
    }
    // Links, hard links and foreign files are never followed or copied.
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      skipped++;
      return;
    }
    // Past the budget, workspaces are no longer read at all.
    if (
      relative.startsWith("workspaces/") &&
      (oversize || workspaceBytes + stat.size > limit)
    ) {
      oversize = true;
      return;
    }
    // Other data past the budget is not read either.
    if (!relative.startsWith("workspaces/") && bytes + stat.size > limit) throw overflow;
    const aad = `${id}\0${relative}`;
    const content = readFile(source, limit);
    if (isSqlite(content) && sealedTree(relative)) {
      // Live databases are first copied consistently, then sealed from that copy.
      const consistent = path.join(work, randomUUID());
      fs.writeFileSync(consistent, sqliteSnapshot(source, work), { mode: 0o600 });
      const copy = path.join(work, randomUUID());
      const moved = await sealDatabase(consistent, copy, { key, aad, tmp: work });
      add(relative, readFile(copy, limit));
      if (moved && sealing) {
        add(relative + sealedSuffix, readFile(copy + sealedSuffix, limit));
        sealed.push(relative);
      } else withheld ||= moved;
    } else if (isSqlite(content)) add(relative, sqliteSnapshot(source, work));
    else if (isRelocatable(relative)) {
      const text = portableText(content.toString("utf8"), root);
      if (text === null) unreadable = true;
      else if (relative !== configPath) add(relative, Buffer.from(text));
      else addConfig(relative, text, aad);
    } else if (isCredentialFile(relative)) {
      if (!sealing) withheld = true;
      else {
        add(relative + sealedSuffix, seal(key, aad, content));
        sealed.push(relative);
      }
    } else add(relative, content);
  }
  function addConfig(relative, text, aad) {
    const result = sealConfig(text, key, aad);
    if (result.sealed && sealing) sealed.push(relative);
    else if (result.sealed) withheld = true;
    add(
      relative,
      Buffer.from(
        result.sealed && !sealing
          ? unsealConfig(result.text, null, aad).text
          : result.text,
      ),
    );
  }
  try {
    await entry(root, "");
  } catch (error) {
    if (sealing) destroyBackupKey(root, id);
    // Agent data never fails the whole host backup by its size.
    if (error === overflow || error?.status === 413) return omitted(tooLargeOmission);
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  // A key that seals nothing would only outlive the backup.
  if (sealing && !sealed.length) destroyBackupKey(root, id);
  // Workspaces are kept whole or not at all, so the agents' ledgers always fit.
  const fits =
    !oversize &&
    bytes + workspaceBytes <= limit &&
    files.length + workspaces.length <= 20000;
  if (fits) files.push(...workspaces);
  return {
    files,
    captures: [
      {
        component: prefix,
        startedAt,
        finishedAt: new Date().toISOString(),
        consistency: "independent-native-capture",
      },
    ],
    omissions: [
      ...assistantOmissions,
      ...(fits ? [] : [workspaceOmission]),
      ...(unreadable ? [unreadableOmission] : []),
      ...(skipped ? ["Assistant links and files not owned by AgentPier"] : []),
    ],
    manifest: { id, sealed: sealed.sort(), withheld },
  };
}

/** Destroys the key of a deleted host backup; a missing assistant folder is ignored. */
export function forgetAssistantBackup(dataDir, id) {
  if (assistantsCaptured(dataDir)) destroyBackupKey(path.join(dataDir, prefix), id);
}

function relocatableFiles(root) {
  const found = fs.existsSync(path.join(root, configPath)) ? [configPath] : [];
  const agents = path.join(root, "state", "agents");
  if (fs.existsSync(agents))
    for (const agent of fs.readdirSync(agents).sort()) {
      const relative = `state/agents/${agent}/sessions/sessions.json`;
      if (isRelocatable(relative) && fs.existsSync(path.join(root, relative)))
        found.push(relative);
    }
  return found;
}

/** Validates the manifest entry against the archive's sealed members. */
export function validateAssistantManifest(value, files) {
  const sidecars = files
    .map((member) => member.path)
    .filter((name) => name.startsWith(`${prefix}/`) && name.endsWith(sealedSuffix));
  // Relocated files must parse and stay inside assistants/ wherever they land.
  for (const member of files)
    if (
      member.path.startsWith(`${prefix}/`) &&
      isRelocatable(member.path.slice(prefix.length + 1))
    )
      restoredText(
        Buffer.from(member.content, "base64").toString("utf8"),
        path.join(path.parse(process.cwd()).root, "agentpier-restore", prefix),
      );
  if (value === undefined) {
    if (sidecars.length) throw problem(serverMessages.backups.invalidManifest);
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.withheld !== "boolean" ||
    !Array.isArray(value.sealed) ||
    value.sealed.some(
      (relative) =>
        typeof relative !== "string" || !isAssistantMember(`${prefix}/${relative}`),
    )
  )
    throw problem(serverMessages.backups.invalidManifest);
  // Every sidecar is declared, and every declared entry has the member it unseals.
  const paths = new Set(files.map((member) => member.path));
  const expected = new Set(value.sealed.map((relative) => `${prefix}/${relative}`));
  if (
    sidecars.some((name) => !expected.has(name.slice(0, -sealedSuffix.length))) ||
    value.sealed.some((relative) => {
      const name = `${prefix}/${relative}`;
      return !paths.has(relative === configPath ? name : name + sealedSuffix);
    })
  )
    throw problem(serverMessages.backups.invalidManifest);
}

/**
 * Restores sealed assistant credentials into a staged data directory, using the key
 * still held by this host's live store. Without it they stay withheld.
 */
export async function restoreAssistants({ stage, target, liveDataDir, value }) {
  const root = path.join(stage, prefix);
  // Paths inside the Gateway's JSON files point at the restored location.
  for (const relative of relocatableFiles(root)) {
    const file = path.join(root, relative);
    await fsp.writeFile(
      file,
      restoredText(await fsp.readFile(file, "utf8"), path.join(target, prefix)),
      { mode: 0o600 },
    );
  }
  if (!value) return { withheld: false };
  const key = value.sealed.length
    ? readBackupKey(path.join(liveDataDir, prefix), value.id)
    : null;
  let withheld = value.withheld;
  for (const relative of value.sealed) {
    const file = path.join(root, relative),
      sidecar = file + sealedSuffix,
      aad = `${value.id}\0${relative}`;
    if (relative === configPath) {
      const result = unsealConfig(await fsp.readFile(file, "utf8"), key, aad);
      await fsp.writeFile(file, result.text, { mode: 0o600 });
      withheld ||= result.withheld;
    } else if (isCredentialFile(relative)) {
      if (key)
        await fsp.writeFile(file, unseal(key, aad, await fsp.readFile(sidecar)), {
          mode: 0o600,
          flag: "wx",
        });
      else withheld = true;
    } else withheld ||= !(await unsealDatabase(file, sidecar, key, aad));
    await fsp.rm(sidecar, { force: true });
  }
  return { withheld };
}
