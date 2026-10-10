import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { privateFolder } from "./runtime-paths.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import {
  configPath,
  createBackupKey,
  isCredentialFile,
  isDatabase,
  readBackupKey,
  seal,
  sealConfig,
  sealDatabase,
  sealedSuffix,
  unseal,
  unsealConfig,
  unsealDatabase,
} from "./backup-credentials.js";

const trees = ["home", "state", "workspaces"];
// Only Gateway home/state databases can hold credential tables; workspace files,
// including user databases, are copied byte for byte.
const sealedTrees = new Set(["home", "state"]);
const sqliteHeader = Buffer.from("SQLite format 3\0");
async function isSqlite(file) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile()) return false;
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return bytesRead === 16 && buffer.equals(sqliteHeader);
  } finally {
    await handle.close();
  }
}
const journals = ["-wal", "-shm", "-journal"];
const uid = process.getuid?.();
const join = (relative, name) => (relative ? `${relative}/${name}` : name);
/** Every snapshot failure names the relative path it could not handle. */
function failed(relative, cause) {
  if (cause?.code === "SNAPSHOT_FAILED") return cause;
  return Object.assign(Error(`Update snapshot failed at ${relative}.`), {
    code: "SNAPSHOT_FAILED",
    path: relative,
    cause,
  });
}
function owned(stat) {
  return uid === undefined || stat.uid === uid;
}
function sync(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
async function syncAsync(file) {
  const handle = await fsp.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export function durablePrivate(file, value) {
  writePrivate(file, value);
  sync(file);
  sync(path.dirname(file));
}
// A relative link that stays inside its own tree restores to the same target. Any
// other link is still copied as a link, but its target is outside this boundary.
function internalLink(relative, target) {
  if (path.isAbsolute(target)) return false;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relative), target),
  );
  return resolved.split("/")[0] === relative.split("/")[0];
}
async function copyFile(source, destination, mode) {
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(destination, (mode & 0o700) | 0o600);
  await syncAsync(destination);
}
async function copyEntry(source, destination, context, relative) {
  try {
    const stat = await fsp.lstat(source);
    if (!owned(stat)) throw failed(relative);
    if (stat.isSymbolicLink()) {
      const target = await fsp.readlink(source);
      await fsp.symlink(target, destination);
      if (!internalLink(relative, target)) context.excludedLinks.push(relative);
    } else if (stat.isDirectory()) {
      await fsp.mkdir(destination, { mode: 0o700 });
      const names = (await fsp.readdir(source)).sort();
      // A database copy is self-contained; its journals are not copied separately.
      const databases = [];
      if (context.sealing && sealedTrees.has(relative.split("/")[0]))
        for (const name of names.filter(isDatabase))
          if (await isSqlite(path.join(source, name))) {
            databases.push(name);
            context.databases.add(path.join(source, name));
          }
      const skip = new Set(databases.flatMap((name) => journals.map((s) => name + s)));
      for (const name of names) {
        if (skip.has(name) || (!context.sealing && name.endsWith(sealedSuffix))) continue;
        await copyEntry(
          path.join(source, name),
          path.join(destination, name),
          context,
          join(relative, name),
        );
      }
      await syncAsync(destination);
    } else if (!stat.isFile()) context.skipped.push(relative);
    else if (!context.sealing) await copyFile(source, destination, stat.mode);
    else await sealEntry(source, destination, context, relative, stat);
  } catch (error) {
    throw failed(relative, error);
  }
}
async function sealEntry(source, destination, context, relative, stat) {
  const aad = `${context.id}\0${relative}`;
  if (relative === configPath) {
    const result = sealConfig(await fsp.readFile(source, "utf8"), context.key, aad);
    await fsp.writeFile(destination, result.text, { mode: 0o600, flag: "wx" });
    if (result.sealed) context.sealed.push(relative);
  } else if (isCredentialFile(relative)) {
    const data = seal(context.key, aad, await fsp.readFile(source));
    await fsp.writeFile(destination + sealedSuffix, data, { mode: 0o600, flag: "wx" });
    context.sealed.push(relative);
  } else if (context.databases.has(source)) {
    if (await sealDatabase(source, destination, { ...context, aad }))
      context.sealed.push(relative);
  } else return copyFile(source, destination, stat.mode);
  await syncAsync(destination + (isCredentialFile(relative) ? sealedSuffix : ""));
}
async function digestTree(directory, excluded) {
  const hash = createHash("sha256");
  async function visit(file, relative) {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) {
      if (!excluded.has(relative))
        hash.update(JSON.stringify([relative, "link", await fsp.readlink(file)]));
      return;
    }
    hash.update(
      JSON.stringify([
        relative,
        stat.isDirectory() ? "directory" : "file",
        stat.isFile() ? stat.size : null,
      ]),
    );
    if (stat.isDirectory()) {
      for (const name of (await fsp.readdir(file)).sort())
        await visit(path.join(file, name), join(relative, name));
      return;
    }
    if (!stat.isFile() || !owned(stat)) throw failed(relative);
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let read;
      while ((read = await handle.read(buffer, 0, buffer.length, null)).bytesRead)
        hash.update(buffer.subarray(0, read.bytesRead));
    } finally {
      await handle.close();
    }
  }
  await visit(directory, "");
  return hash.digest("hex");
}
function regular(file, relative) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || !owned(stat)) throw failed(relative);
}
/**
 * Content digests of AgentPier's ledgers. `fence` records each table's highest rowid
 * at snapshot time; rows the validation itself inserted after it are excluded.
 */
function ledgerState(root, exclusions = [], fence = null) {
  const excluded = new Set(exclusions.map((entry) => JSON.stringify(entry)));
  const digests = {},
    fences = {};
  for (const name of fs
    .readdirSync(root)
    .filter((n) => n.endsWith(".sqlite"))
    .sort()) {
    const file = path.join(root, name);
    for (const suffix of ["", ...journals])
      if (fs.existsSync(file + suffix)) regular(file + suffix, name + suffix);
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const hash = createHash("sha256");
      hash.update(
        JSON.stringify([
          database.prepare("PRAGMA user_version").get(),
          database.prepare("PRAGMA application_id").get(),
        ]),
      );
      const schema = database
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
        .all();
      hash.update(JSON.stringify(schema));
      fences[name] = {};
      for (const table of schema.filter((entry) => entry.type === "table")) {
        const quoted = `"${table.name.replaceAll('"', '""')}"`;
        const boundary = fence?.[name]?.[table.name];
        let statement,
          highest = 0n;
        try {
          statement = database.prepare(
            `SELECT rowid AS __snapshot_rowid, * FROM ${quoted}`,
          );
        } catch {
          statement = database.prepare(`SELECT * FROM ${quoted}`);
          highest = null;
        }
        statement.setReadBigInts(true);
        const rows = [];
        for (const row of statement.all()) {
          const rowid = row.__snapshot_rowid;
          if (highest !== null && rowid > highest) highest = rowid;
          if (
            boundary != null &&
            rowid > BigInt(boundary) &&
            excluded.has(JSON.stringify([name, table.name, String(rowid)]))
          )
            continue;
          rows.push(
            JSON.stringify(
              Object.entries(row).map(([key, value]) => [
                key,
                typeof value,
                typeof value === "bigint" ? String(value) : value,
              ]),
            ),
          );
        }
        fences[name][table.name] = highest === null ? null : String(highest);
        hash.update(JSON.stringify([table.name, rows.sort()]));
      }
      digests[name] = hash.digest("hex");
    } finally {
      database.close();
    }
  }
  return { digests, fence: fences };
}
/** Bytes a snapshot of the current trees and ledgers will occupy, at most. */
export async function estimateSnapshotSize(paths) {
  let total = 0;
  async function visit(file) {
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat) return;
    total += stat.isFile() ? stat.size : 4096;
    if (stat.isDirectory())
      for (const name of await fsp.readdir(file)) await visit(path.join(file, name));
  }
  for (const name of trees) await visit(paths[name]);
  for (const name of fs.readdirSync(paths.root).filter((n) => n.endsWith(".sqlite")))
    for (const suffix of ["", ...journals])
      await visit(path.join(paths.root, name + suffix));
  return total;
}
export async function createUpdateSnapshot(paths, directory, metadata) {
  privateFolder(directory);
  const payload = privateFolder(path.join(directory, "payload"));
  const id = path.basename(directory);
  const context = {
    id,
    key: await createBackupKey(paths.root, id),
    tmp: paths.tmp,
    sealing: true,
    databases: new Set(),
    excludedLinks: [],
    skipped: [],
    sealed: [],
  };
  const ledgers = ledgerState(paths.root);
  for (const name of trees)
    await copyEntry(paths[name], path.join(payload, name), context, name);
  const ledgerFolder = privateFolder(path.join(payload, "ledgers"));
  for (const name of Object.keys(ledgers.digests)) {
    const relative = `ledgers/${name}`;
    try {
      const sealed = await sealDatabase(
        path.join(paths.root, name),
        path.join(ledgerFolder, name),
        { ...context, aad: `${id}\0${relative}` },
      );
      if (sealed) context.sealed.push(relative);
    } catch (error) {
      throw failed(relative, error);
    }
  }
  if (JSON.stringify(ledgers.digests) !== JSON.stringify(ledgerState(paths.root).digests))
    throw Error("Assistant ledgers changed during snapshot.");
  const manifest = {
    format: 2,
    ...metadata,
    ledgers: ledgers.digests,
    fence: ledgers.fence,
    excludedLinks: context.excludedLinks.sort(),
    skipped: context.skipped.sort(),
    sealed: context.sealed.sort(),
  };
  manifest.digest = await digestTree(payload, new Set(manifest.excludedLinks));
  durablePrivate(path.join(directory, "snapshot.json"), manifest);
  sync(ledgerFolder);
  sync(payload);
  sync(directory);
  sync(path.dirname(directory));
  return manifest;
}
export async function verifyUpdateSnapshot(paths, directory, exclusions = []) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || !owned(stat)) throw failed(path.basename(directory));
  const manifestFile = path.join(directory, "snapshot.json");
  regular(manifestFile, "snapshot.json");
  const manifest = readJSON(manifestFile);
  const payload = path.join(directory, "payload");
  if (
    ![1, 2].includes(manifest.format) ||
    manifest.digest !== (await digestTree(payload, new Set(manifest.excludedLinks))) ||
    JSON.stringify(manifest.ledgers) !==
      JSON.stringify(ledgerState(paths.root, exclusions, manifest.fence).digests)
  )
    throw Error("Update restore boundary no longer matches.");
  return manifest;
}
export async function restoreUpdateSnapshot(paths, directory, exclusions = []) {
  const manifest = await verifyUpdateSnapshot(paths, directory, exclusions);
  const payload = path.join(directory, "payload");
  const id = path.basename(directory);
  // Gateway state may migrate; AgentPier's frozen ledgers may not. Never replace
  // an open database or erase a newly recorded effect to make rollback succeed.
  const context = { sealing: false, excludedLinks: [], skipped: [] };
  for (const name of trees) {
    const live = await fsp.lstat(paths[name]).catch(() => null);
    if (live && (!live.isDirectory() || !owned(live))) throw failed(name);
    await fsp.rm(paths[name], { recursive: true, force: true });
    await copyEntry(path.join(payload, name), paths[name], context, name);
  }
  const key = readBackupKey(paths.root, id);
  let withheld = false;
  for (const relative of manifest.sealed || []) {
    const [tree, ...rest] = relative.split("/");
    if (!trees.includes(tree)) continue;
    const live = path.join(paths[tree], ...rest);
    const aad = `${id}\0${relative}`;
    if (relative === configPath) {
      const result = unsealConfig(await fsp.readFile(live, "utf8"), key, aad);
      await fsp.writeFile(live, result.text, { mode: 0o600 });
      withheld ||= result.withheld;
    } else if (!isCredentialFile(relative)) {
      const sidecar = path.join(payload, relative + sealedSuffix);
      withheld ||= !(await unsealDatabase(live, sidecar, key, aad));
    } else if (key) {
      const data = unseal(
        key,
        aad,
        await fsp.readFile(path.join(payload, relative + sealedSuffix)),
      );
      await fsp.writeFile(live, data, { mode: 0o600, flag: "wx" });
    } else withheld = true;
  }
  sync(paths.root);
  return { ...manifest, credentialsWithheld: withheld };
}
