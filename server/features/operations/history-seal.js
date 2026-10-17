import { serverMessages } from "../../lib/i18n/de.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { fileMember } from "./snapshot.js";
import { relativeName } from "./files.js";
import { profileMemberKind } from "./profile-allowlist.js";
import { isBrowserProfilePath } from "./browser-profile-backup.js";

const cleanPath = (name) => {
  try {
    return relativeName(name) === name;
  } catch {
    return false;
  }
};

// AgentPier's own histories: terminal captures, chats and AgentBus messages.
const ownHistory =
  /^(sessions\/[A-Za-z0-9_-]+\.(json|screen|events\.jsonl|outcome\.json)|chat\/[A-Za-z0-9_.-]+\.json|imported-history\/agentbus\/[a-f0-9]{64}\/inbox\/.+)$/;
/** Whether `name` is one of AgentPier's own history files. */
export const isOwnHistoryPath = (name) => ownHistory.test(name);
/**
 * Whether `name` is a history file, which backups archive only sealed; an agent's
 * browser profile is sealed the same way.
 */
export const isHistoryPath = (name) =>
  isOwnHistoryPath(name) ||
  profileMemberKind(name) === "history" ||
  isBrowserProfilePath(name);

/**
 * Histories, AgentPier's own and the CLIs', are archived only in backups with a
 * passphrase, and then sealed
 * (docs/backups.md): AES-256-GCM over fixed-size chunks with a key random per
 * backup. The key, the backup id and which entry holds which history file live in
 * the passphrase capsule (`SEAL_MEMBER`); the archive shows only opaque entry names
 * (`sealed/<n>`) and ciphertext sizes and hashes.
 *
 * Chunk i of entry n: ciphertext of up to CHUNK plaintext bytes plus a 16-byte tag.
 * Nonce: n (4 bytes) and i (8 bytes). Additional data: backup id, history path,
 * i and whether it is the last chunk, so a chunk cannot be moved, reordered,
 * dropped at the end or attached to another file.
 */
export const SEAL_MEMBER = "history-seal.json";
/**
 * Record version 1 (AgentPier 2.0 to 2.2) sealed CLI histories only; AgentPier's
 * own histories were public members then. Version 2 seals both, and no public
 * history may stand beside it.
 */
export const SEAL_VERSION = 2;
export const CHUNK = 1024 * 1024;
const TAG = 16;
const failed = () => problem(serverMessages.backups.historyAuthenticationFailed);

/** Archive size of a sealed file of `size` plaintext bytes. */
export function sealedSize(size) {
  return size + TAG * Math.max(1, Math.ceil(size / CHUNK));
}
const nonce = (entry, index) => {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(entry, 0);
  value.writeBigUInt64BE(BigInt(index), 4);
  return value;
};
const aad = (seal, index, last) =>
  Buffer.from(`${seal.id}\0${seal.path}\0${index}\0${last ? 1 : 0}`);

/**
 * Plans sealing for history members of backup `id`: each gets an opaque archive
 * name and a `seal`; the returned `record` goes into the capsule.
 */
export function sealHistory(id, members) {
  const key = randomBytes(32);
  const sealed = members.map((member, entry) => ({
    ...member,
    name: `sealed/${entry}`,
    seal: { key, id, entry, path: member.path },
  }));
  const record = fileMember(SEAL_MEMBER, {
    version: SEAL_VERSION,
    cipher: "aes-256-gcm",
    chunk: CHUNK,
    id,
    key: key.toString("base64"),
    members: sealed.map((member) => ({ name: member.name, path: member.path })),
  });
  return { members: sealed, record };
}

/** Seals `size` plaintext bytes from `chunks` into ciphertext chunks. */
export async function* sealChunks(chunks, size, seal) {
  let pending = [],
    pendingLength = 0,
    index = 0,
    consumed = 0;
  const emit = (data) => {
    consumed += data.length;
    const last = consumed === size;
    const cipher = createCipheriv("aes-256-gcm", seal.key, nonce(seal.entry, index));
    cipher.setAAD(aad(seal, index, last));
    index++;
    return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  };
  if (size === 0) {
    yield emit(Buffer.alloc(0));
    return;
  }
  for await (const chunk of chunks) {
    pending.push(chunk);
    pendingLength += chunk.length;
    while (pendingLength >= CHUNK) {
      const all = Buffer.concat(pending, pendingLength);
      yield emit(all.subarray(0, CHUNK));
      pending = [all.subarray(CHUNK)];
      pendingLength -= CHUNK;
    }
  }
  if (pendingLength) yield emit(Buffer.concat(pending, pendingLength));
  if (consumed !== size) throw failed();
}

/**
 * Opens a sealed entry of `size` archive bytes while it streams: `update(chunk)`
 * returns plaintext of the chunks completed and authenticated so far, `final()`
 * the rest. Any tampering, truncation or reordering throws; no unauthenticated
 * byte is ever returned.
 */
export class Unsealer {
  constructor(seal, size) {
    this.seal = seal;
    this.size = size;
    this.chunks = Math.max(1, Math.ceil(size / (CHUNK + TAG)));
    const lastSize = size - (this.chunks - 1) * (CHUNK + TAG);
    if (lastSize < TAG) throw failed();
    this.index = 0;
    this.parts = [];
    this.length = 0;
  }
  open(data) {
    const last = this.index === this.chunks - 1;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.seal.key,
      nonce(this.seal.entry, this.index),
    );
    decipher.setAAD(aad(this.seal, this.index, last));
    decipher.setAuthTag(data.subarray(data.length - TAG));
    this.index++;
    try {
      return Buffer.concat([
        decipher.update(data.subarray(0, data.length - TAG)),
        decipher.final(),
      ]);
    } catch {
      throw failed();
    }
  }
  update(chunk) {
    this.parts.push(chunk);
    this.length += chunk.length;
    const opened = [];
    // The last chunk waits for final(), whatever its size.
    while (this.length >= CHUNK + TAG && this.index < this.chunks - 1) {
      const all = Buffer.concat(this.parts, this.length);
      opened.push(this.open(all.subarray(0, CHUNK + TAG)));
      this.parts = [all.subarray(CHUNK + TAG)];
      this.length -= CHUNK + TAG;
    }
    return opened;
  }
  final() {
    if (this.index !== this.chunks - 1) throw failed();
    return [this.open(Buffer.concat(this.parts, this.length))];
  }
}

/**
 * The seal record from decrypted capsule members as `{ version, seals }` (seals by
 * entry name), or null; validated.
 */
export function sealRecord(secrets) {
  const member = secrets.find((entry) => entry.path === SEAL_MEMBER);
  if (!member) return null;
  let value;
  try {
    value = JSON.parse(Buffer.from(member.content, "base64"));
  } catch {
    throw failed();
  }
  // A newer AgentPier wrote it: say so rather than call it damaged.
  if (Number.isSafeInteger(value?.version) && value.version > SEAL_VERSION)
    throw problem(serverMessages.backups.unsupportedHistorySeal, 409);
  const key = Buffer.from(value?.key || "", "base64");
  if (
    !value ||
    Object.keys(value).sort().join() !== "chunk,cipher,id,key,members,version" ||
    ![1, SEAL_VERSION].includes(value.version) ||
    value.cipher !== "aes-256-gcm" ||
    value.chunk !== CHUNK ||
    typeof value.id !== "string" ||
    key.length !== 32 ||
    !Array.isArray(value.members)
  )
    throw failed();
  const byName = new Map(),
    paths = new Set();
  for (const [entry, item] of value.members.entries()) {
    // Each entry restores to a history path (version 1: a CLI history path),
    // and to no other entry's path.
    // Paths that differ only in case or normalization are distinct, as public
    // members are: a file system that ignores the difference refuses the second
    // file when it is written (caseConflict).
    if (
      !item ||
      Object.keys(item).sort().join() !== "name,path" ||
      item.name !== `sealed/${entry}` ||
      !cleanPath(item.path) ||
      !(value.version === 1
        ? profileMemberKind(item.path) === "history"
        : isHistoryPath(item.path)) ||
      paths.has(item.path)
    )
      throw failed();
    paths.add(item.path);
    byName.set(item.name, { key, id: value.id, entry, path: item.path });
  }
  return { version: value.version, seals: byName };
}
