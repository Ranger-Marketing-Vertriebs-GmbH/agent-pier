import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { privateDirectory, readJSON, problem } from "../../lib/storage.js";
import { writeCatalogSnapshot as writePrivate } from "./ssh-catalog-snapshot.js";
import { sshPhysicalRoot } from "./ssh-root.js";
import { SshKeyStore } from "./ssh-key-store.js";

const parts = ["keys", "hosts", "receipts", "projects"];
export const SSH_CATALOG_LIMIT = 16 * 1024 * 1024;
function deletionOnly(before, after) {
  const removed = new Set(
    [...before.keys, ...before.hosts]
      .filter(
        (row) => ![...after.keys, ...after.hosts].some((next) => next.id === row.id),
      )
      .map((row) => row.id),
  );
  if (!removed.size) return false;
  const expected = structuredClone(before);
  for (const part of ["keys", "hosts"])
    expected[part] = expected[part].filter((row) => !removed.has(row.id));
  expected.receipts = expected.receipts.map((r) =>
    [r.resourceId, r.keyId, r.accessId].some((id) => removed.has(id))
      ? { ...r, tombstone: true }
      : r,
  );
  return JSON.stringify(expected) === JSON.stringify(after);
}
export class SshCatalog {
  constructor({ dataDir }) {
    this.root = sshPhysicalRoot(dataDir);
    this.file = path.join(this.root, "catalog.json");
    this.context = new AsyncLocalStorage();
    this.queue = Promise.resolve();
  }
  read() {
    const transaction = this.context.getStore();
    if (transaction) return structuredClone(transaction.draft);
    const snapshot = readJSON(this.file, null);
    if (
      !snapshot ||
      snapshot.version !== 1 ||
      parts.some((p) => !Array.isArray(snapshot[p]))
    )
      throw problem("SSH catalog is unavailable.", 503);
    return snapshot;
  }
  migrate() {
    privateDirectory(this.root);
    const marker = path.join(this.root, "migration.json");
    if (!fs.existsSync(this.file)) {
      writePrivate(marker, { phase: "cutover" });
      fs.rmSync(path.join(this.root, "capabilities"), { recursive: true, force: true });
      const keys = new SshKeyStore({ root: this.root });
      let hosts = readJSON(path.join(this.root, "accesses.json"), []);
      if (hosts.some((h) => !h.keyId)) hosts = keys.migrateAccesses(hosts);
      writePrivate(this.file, {
        version: 1,
        keys: keys.raw().map((k) => ({ ...k, projectId: null })),
        hosts: hosts.map((h) => ({ ...h, projectId: null })),
        receipts: [],
        projects: [],
      });
    }
    this.read();
    if (fs.existsSync(marker)) {
      for (const name of ["keys.json", "accesses.json"]) {
        const file = path.join(this.root, name);
        if (fs.existsSync(file)) fs.renameSync(file, `${file}.legacy`);
      }
      fs.rmSync(marker);
    }
    this.recoverArtifacts();
  }
  recoverArtifacts() {
    const owned = new Set(this.read().keys.map((k) => k.id));
    for (const part of ["identities", "staging"]) {
      const directory = path.join(this.root, part);
      if (!fs.existsSync(directory)) continue;
      for (const id of fs.readdirSync(directory)) {
        if (!/^[0-9a-f-]{36}$/.test(id) || (part === "identities" && owned.has(id)))
          continue;
        const artifact = path.join(directory, id);
        if (fs.existsSync(path.join(artifact, ".catalog-owned")))
          fs.rmSync(artifact, { recursive: true, force: true });
      }
    }
  }

  replacePart(name, rows) {
    const transaction = this.context.getStore();
    if (!transaction || !parts.includes(name) || !Array.isArray(rows))
      throw problem("SSH catalog mutation requires a transaction.", 503);
    transaction.draft[name] = structuredClone(rows);
  }
  beforeCommit(callback) {
    this.context.getStore().guards.push(callback);
  }
  afterCommit(callback) {
    this.context.getStore().commit.push(callback);
  }
  afterRollback(callback) {
    this.context.getStore().rollback.push(callback);
  }
  tombstone(id) {
    this.replacePart(
      "receipts",
      this.read().receipts.map((r) =>
        [r.resourceId, r.keyId, r.accessId].includes(id) ? { ...r, tombstone: true } : r,
      ),
    );
  }
  run(callback) {
    if (this.context.getStore()) return Promise.resolve().then(callback);
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const before = this.read();
        const transaction = {
          draft: structuredClone(before),
          commit: [],
          rollback: [],
          guards: [],
        };
        return this.context.run(transaction, async () => {
          let result;
          try {
            result = await callback();
            const size = (value) =>
              Buffer.byteLength(JSON.stringify(value, null, 2) + "\n");
            if (
              size(transaction.draft) > SSH_CATALOG_LIMIT &&
              size(transaction.draft) > size(before) &&
              !deletionOnly(before, transaction.draft)
            )
              throw Object.assign(problem("SSH catalog capacity reached.", 409), {
                code: "SSH_STORAGE_LIMIT",
              });
            // Guards are synchronous: no revocation can interleave before publication.
            for (const guard of transaction.guards) guard();
            writePrivate(this.file, transaction.draft);
          } catch (error) {
            for (const cleanup of transaction.rollback) {
              try {
                await cleanup();
              } catch {}
            }
            throw error;
          }
          // Once published, a cleanup failure must not turn a committed operation into failure.
          for (const cleanup of transaction.commit) {
            try {
              await cleanup();
            } catch {}
          }
          return result;
        });
      });
    this.queue = operation;
    return operation;
  }
}
