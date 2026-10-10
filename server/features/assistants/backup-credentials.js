import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { privateFolder } from "./runtime-paths.js";

/**
 * Update backups keep credentials only in sealed form (AES-256-GCM). Each backup has
 * its own key, which lives solely in the live private store. Logging out, rotating or
 * disconnecting a credential destroys every backup key first, so a later rollback
 * restores history and state but can never resurrect the revoked credential.
 */
export const sealedSuffix = ".agentpier-sealed";
const magic = Buffer.from("APSEAL1\0");
const marker = "$agentpierSealed";
// OpenClaw 2026.9.x: per-agent and legacy auth stores plus its OAuth directory.
const credentialFiles = new Set([
  "auth-profiles.json",
  "auth-state.json",
  "auth.json",
  "oauth.json",
]);
// OpenClaw state databases and AgentPier's channel ledger.
const credentialTables = new Set([
  "auth_profile_store",
  "auth_profile_state",
  "secret_store_entries",
  "mcp_oauth_stores",
  "mcp_oauth_pending_authorizations",
  "device_auth_tokens",
  "device_bootstrap_tokens",
  "gateway_origin_device_tokens",
  "worker_environment_credentials",
  "channel_credentials",
]);
// Secret members of openclaw.json: Gateway, cron and plugin tokens and provider keys.
const secretMembers = new Set([
  "token",
  "apiKey",
  "api_key",
  "webhookToken",
  "headers",
  "authorization",
  "secret",
  "clientSecret",
  "password",
  "accessToken",
  "refreshToken",
  "botToken",
]);
export const configPath = "state/openclaw.json";
export const isDatabase = (name) => /\.(sqlite3?|db)$/.test(name);
export function isCredentialFile(relative) {
  const [tree, ...rest] = relative.split("/");
  if (!["home", "state"].includes(tree)) return false;
  return (
    (tree === "state" && rest[0] === "credentials" && rest.length > 1) ||
    credentialFiles.has(rest.at(-1))
  );
}

const keyFolder = (root) => path.join(root, "backup-keys");
function keyFile(root, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid backup identity.");
  return path.join(keyFolder(root), `${id}.key`);
}
function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
export async function createBackupKey(root, id) {
  privateFolder(keyFolder(root));
  const key = randomBytes(32);
  const handle = await fsp.open(keyFile(root, id), "wx", 0o600);
  try {
    await handle.writeFile(key);
    await handle.sync();
  } finally {
    await handle.close();
  }
  syncDirectory(keyFolder(root));
  return key;
}
export function readBackupKey(root, id) {
  try {
    const file = keyFile(root, id),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== 32) return null;
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function shred(file) {
  try {
    const descriptor = fs.openSync(file, "r+");
    try {
      fs.writeSync(descriptor, Buffer.alloc(32), 0, 32, 0);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(file, { force: true });
}
export function destroyBackupKey(root, id) {
  shred(keyFile(root, id));
  if (fs.existsSync(keyFolder(root))) syncDirectory(keyFolder(root));
}
// Update backups of format 1 predate sealing and hold credentials in plain text.
function removeLegacyBackups(root) {
  const folder = path.join(root, "backups");
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(folder, name, "snapshot.json")));
    } catch {
      continue;
    }
    if (manifest?.format === 1)
      fs.rmSync(path.join(folder, name), { recursive: true, force: true });
  }
}
/**
 * Called before any credential revocation; throws rather than leave a key or a
 * plaintext legacy backup behind.
 */
export function destroyBackupKeys(root) {
  removeLegacyBackups(root);
  let names;
  try {
    names = fs.readdirSync(keyFolder(root));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names)
    if (name.endsWith(".key")) shred(path.join(keyFolder(root), name));
  syncDirectory(keyFolder(root));
}

export function seal(key, aad, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), data]);
}
export function unseal(key, aad, sealed) {
  if (
    sealed.length < magic.length + 12 + 16 ||
    !sealed.subarray(0, magic.length).equals(magic)
  )
    throw Error("Invalid sealed data.");
  const iv = sealed.subarray(8, 20),
    tag = sealed.subarray(20, 36);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(36)), decipher.final()]);
}

function mapSecrets(value, transform, trail = []) {
  if (Array.isArray(value))
    return value.map((v, n) => mapSecrets(v, transform, [...trail, n]));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [name, member] of Object.entries(value)) {
    const next = transform(name, member, [...trail, name]);
    if (next !== undefined) result[name] = next;
  }
  return result;
}
/** Seals the secret members of openclaw.json; the rest stays readable for restore. */
export function sealConfig(text, key, aad) {
  let sealed = false;
  const visit = (value, trail) =>
    mapSecrets(
      value,
      (name, member, at) => {
        if (secretMembers.has(name) && member !== null && member !== "") {
          sealed = true;
          const data = seal(key, `${aad}\0${at.join("/")}`, JSON.stringify(member));
          return { [marker]: data.toString("base64") };
        }
        return visit(member, at);
      },
      trail,
    );
  const value = visit(JSON.parse(text), []);
  return { sealed, text: JSON.stringify(value, null, 2) };
}
/** Restores sealed members, or drops them when the backup key was destroyed. */
export function unsealConfig(text, key, aad) {
  let withheld = false;
  const visit = (value, trail) =>
    mapSecrets(
      value,
      (name, member, at) => {
        if (member && typeof member === "object" && Object.hasOwn(member, marker)) {
          if (!key) {
            withheld = true;
            return undefined;
          }
          const data = Buffer.from(member[marker], "base64");
          return JSON.parse(unseal(key, `${aad}\0${at.join("/")}`, data).toString());
        }
        return visit(member, at);
      },
      trail,
    );
  return { withheld, text: JSON.stringify(visit(JSON.parse(text), []), null, 2) };
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const encode = (value) =>
  typeof value === "bigint"
    ? { $i: String(value) }
    : value instanceof Uint8Array
      ? { $b: Buffer.from(value).toString("base64") }
      : value;
const decode = (value) =>
  value && typeof value === "object"
    ? "$i" in value
      ? BigInt(value.$i)
      : Buffer.from(value.$b, "base64")
    : value;

/**
 * Writes a self-contained copy of an SQLite database. Credential tables are moved
 * into a sealed sidecar; VACUUM INTO guarantees the copy keeps no freed plaintext.
 */
export async function sealDatabase(source, destination, { key, aad, tmp }) {
  const work = path.join(privateFolder(tmp), `snapshot-${randomUUID()}`);
  await fsp.mkdir(work, { mode: 0o700 });
  try {
    const copy = path.join(work, "database");
    await fsp.copyFile(source, copy, fs.constants.COPYFILE_EXCL);
    for (const suffix of ["-wal", "-shm", "-journal"])
      await fsp.copyFile(source + suffix, copy + suffix).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    const database = new DatabaseSync(copy);
    let sealed = false;
    try {
      database.exec("PRAGMA foreign_keys=OFF");
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name)
        .filter((name) => credentialTables.has(name));
      if (tables.length) {
        const dump = {};
        for (const table of tables) {
          const statement = database.prepare(`SELECT * FROM ${quote(table)}`);
          statement.setReadBigInts(true);
          dump[table] = statement
            .all()
            .map((row) =>
              Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encode(v)])),
            );
          database.exec(`DELETE FROM ${quote(table)}`);
        }
        await fsp.writeFile(
          destination + sealedSuffix,
          seal(key, aad, JSON.stringify(dump)),
          { mode: 0o600, flag: "wx" },
        );
        sealed = true;
      }
      database.prepare("VACUUM INTO ?").run(destination);
    } finally {
      database.close();
    }
    await fsp.chmod(destination, 0o600);
    return sealed;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}
/** Re-inserts sealed credential rows, or leaves the tables empty without a key. */
export async function unsealDatabase(file, sidecar, key, aad) {
  if (!key) return false;
  const dump = JSON.parse(unseal(key, aad, await fsp.readFile(sidecar)).toString());
  const database = new DatabaseSync(file);
  let open = false;
  try {
    database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    open = true;
    for (const [table, rows] of Object.entries(dump))
      for (const row of rows) {
        const names = Object.keys(row);
        database
          .prepare(
            `INSERT INTO ${quote(table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
          )
          .run(...names.map((name) => decode(row[name])));
      }
    database.exec("COMMIT");
    open = false;
  } catch (error) {
    if (open) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return true;
}
