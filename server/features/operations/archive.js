import { gzipSync, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { scrypt, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { digest, relativeName, readFile } from "./files.js";
import { problem } from "../../lib/storage.js";
const derive = promisify(scrypt);
export const ARCHIVE_LIMIT = 256 * 1024 * 1024;
const kdf = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function encodeArchive(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > ARCHIVE_LIMIT)
    throw problem("Archive expansion limit exceeded.", 413);
  return gzipSync(bytes);
}
export function decodeArchive(fileOrBytes, { limit = ARCHIVE_LIMIT } = {}) {
  const bytes = Buffer.isBuffer(fileOrBytes) ? fileOrBytes : readFile(fileOrBytes, limit);
  if (bytes.length > limit) throw problem("Archive size limit exceeded.", 413);
  let value;
  try {
    value = JSON.parse(gunzipSync(bytes, { maxOutputLength: limit }));
  } catch {
    throw problem("Invalid or oversized AgentPier archive.");
  }
  if (
    !value ||
    value.format !== "agentpier-backup" ||
    value.version !== 1 ||
    !value.manifest ||
    value.manifest.schemaVersion !== 1
  )
    throw problem("Unsupported backup format or schema.");
  validateMembers(value.files);
  return value;
}
export function validateMembers(
  files,
  { executable = false, limit = ARCHIVE_LIMIT } = {},
) {
  if (!Array.isArray(files) || files.length > 20000)
    throw problem("Invalid archive members.");
  const names = new Set();
  let size = 0;
  for (const member of files) {
    const name = relativeName(member?.path);
    if (
      names.has(name) ||
      member.type ||
      member.link ||
      (member.mode !== 0o600 && !(executable && member.mode === 0o755))
    )
      throw problem("Duplicate, linked, or invalid archive member.");
    names.add(name);
    if (typeof member.content !== "string") throw problem("Invalid archive encoding.");
    const content = Buffer.from(member.content, "base64");
    if (content.toString("base64") !== member.content)
      throw problem("Invalid archive encoding.");
    size += content.length;
    if (size > limit) throw problem("Archive expansion limit exceeded.", 413);
    if (digest(content) !== member.sha256) throw problem("Archive checksum mismatch.");
  }
  for (const name of names) {
    const parts = name.split("/");
    while (parts.pop() && parts.length)
      if (names.has(parts.join("/")))
        throw problem("Archive file conflicts with a directory.");
  }
  return files;
}
export async function encryptCredentials(files, passphrase) {
  if (
    typeof passphrase !== "string" ||
    passphrase.length < 12 ||
    passphrase.length > 4096
  )
    throw problem("Encrypted backups require a passphrase of 12 to 4096 characters.");
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const header = {
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
  };
  const key = await derive(passphrase, salt, 32, kdf);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const data = Buffer.concat([cipher.update(JSON.stringify(files)), cipher.final()]);
  key.fill(0);
  return {
    header,
    data: data.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
export async function decryptCredentials(capsule, passphrase) {
  const h = capsule?.header;
  if (
    !h ||
    h.version !== 1 ||
    h.cipher !== "aes-256-gcm" ||
    h.kdf !== "scrypt" ||
    h.N !== kdf.N ||
    h.r !== kdf.r ||
    h.p !== kdf.p ||
    Object.keys(h).length !== 8
  )
    throw problem("Unsupported credential encryption parameters.");
  if (typeof passphrase !== "string" || passphrase.length > 4096)
    throw problem("A backup passphrase is required.");
  const salt = Buffer.from(h.salt || "", "base64"),
    iv = Buffer.from(h.iv || "", "base64"),
    tag = Buffer.from(capsule.tag || "", "base64");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16)
    throw problem("Invalid credential encryption envelope.");
  const key = await derive(passphrase, salt, 32, kdf);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(h)));
    decipher.setAuthTag(tag);
    const content = Buffer.concat([
      decipher.update(Buffer.from(capsule.data, "base64")),
      decipher.final(),
    ]);
    return validateMembers(JSON.parse(content));
  } catch {
    throw problem("Backup passphrase or credential authentication failed.");
  } finally {
    key.fill(0);
  }
}
