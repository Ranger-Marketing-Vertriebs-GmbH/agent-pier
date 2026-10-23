import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { privateDirectory, readJSON, problem } from "../../lib/storage.js";
import { writeCatalogSnapshot as writePrivate } from "./ssh-catalog-snapshot.js";
import { sshPhysicalRoot } from "./ssh-root.js";
import { SshKeyStore } from "./ssh-key-store.js";
import { SshPasswordStore } from "./ssh-password-store.js";

const parts = ["keys", "hosts", "receipts", "projects"];
// Optional parts: releases without them validate only `parts` and keep the rest.
const optionalParts = ["sftpHosts"];
const hostParts = ["keys", "hosts", "sftpHosts"];
export const SSH_CATALOG_LIMIT = 16 * 1024 * 1024;
function deletionOnly(before, after) {
  const rows = (catalog) => hostParts.flatMap((part) => catalog[part]);
  const removed = new Set(
    rows(before)
      .filter((row) => !rows(after).some((next) => next.id === row.id))
      .map((row) => row.id),
  );
  if (!removed.size) return false;
  const expected = structuredClone(before);
  for (const part of hostParts)
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
      parts.some((p) => !Array.isArray(snapshot[p])) ||
      optionalParts.some((p) => snapshot[p] !== undefined && !Array.isArray(snapshot[p]))
    )
      throw problem(serverMessages.ssh.catalogUnavailable, 503);
    for (const part of optionalParts) snapshot[part] ??= [];
    return snapshot;
  }
  migrate() {
    privateDirectory(this.root);
    const marker = path.join(this.root, "migration.json");
    const rebuilt = !fs.existsSync(this.file);
    if (rebuilt) {
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
    // A catalog rebuilt from accesses.json has lost its SFTP hosts, not their
    // passwords: keep them for a restored catalog instead of deleting them for good.
    this.recoverArtifacts({ passwords: !rebuilt });
  }
  recoverArtifacts({ passwords = true } = {}) {
    const current = this.read();
    // Passwords are written before a commit; a crash can leave a host's directory.
    if (passwords) this.removePasswordOrphans(current.sftpHosts.map((row) => row.id));
    const owned = new Set(current.keys.map((k) => k.id));
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
  removePasswordOrphans(hostIds) {
    try {
      new SshPasswordStore({ root: this.root }).removeOrphans(hostIds);
    } catch (error) {
      console.warn(
        `SSH catalog kept orphaned SFTP passwords (${error.code || "error"}).`,
      );
    }
  }

  replacePart(name, rows) {
    const transaction = this.context.getStore();
    if (
      !transaction ||
      ![...parts, ...optionalParts].includes(name) ||
      !Array.isArray(rows)
    )
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
              throw Object.assign(problem(serverMessages.ssh.catalogCapacity, 409), {
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
