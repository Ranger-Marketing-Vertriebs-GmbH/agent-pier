// Frozen copy of the SSH catalog reader and writer of a release without SFTP,
// taken from origin/main at commit 16b59a1ab (server/features/ssh/ssh-catalog.js
// `SshCatalog.read()`, ssh-access-store.js `list()/project()`, ssh-key-store.js
// `project()/get()` and the transaction write path). Do not update: it stands for
// what an older AgentPier does with a catalog written by a newer one.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const parts = ["keys", "hosts", "receipts", "projects"];

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function writeCatalogSnapshot(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

export class LegacySshCatalog {
  constructor({ dataDir }) {
    this.root = path.join(path.resolve(dataDir), "ssh");
    this.file = path.join(this.root, "catalog.json");
  }
  read() {
    const snapshot = readJSON(this.file, null);
    if (
      !snapshot ||
      snapshot.version !== 1 ||
      parts.some((p) => !Array.isArray(snapshot[p]))
    )
      throw problem("SSH catalog is unavailable.", 503);
    return snapshot;
  }
  /** The legacy transaction: clone, replace one part, publish the whole draft. */
  replaceHosts(rows) {
    const before = this.read();
    const draft = structuredClone(before);
    draft.hosts = structuredClone(rows);
    writeCatalogSnapshot(this.file, draft);
  }
}

export class LegacySshKeyStore {
  constructor({ catalog, accesses }) {
    this.catalog = catalog;
    this.accesses = accesses;
  }
  project({ id, name, publicKey, fingerprint, createdAt, projectId = null }) {
    return {
      id,
      name,
      publicKey,
      fingerprint,
      createdAt,
      projectId,
      hosts: this.accesses()
        .filter((host) => host.keyId === id)
        .map(({ id, name }) => ({ id, name })),
    };
  }
  list() {
    return this.catalog.read().keys.map((key) => this.project(key));
  }
  get(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      throw problem("SSH key not found.", 404);
    const key = this.list().find((key) => key.id === id);
    if (!key) throw problem("SSH key not found.", 404);
    return key;
  }
}

export class LegacySshAccessStore {
  constructor({ dataDir }) {
    this.catalog = new LegacySshCatalog({ dataDir });
    this.keyStore = new LegacySshKeyStore({
      catalog: this.catalog,
      accesses: () => this.raw(),
    });
  }
  raw() {
    return this.catalog.read().hosts;
  }
  list() {
    return this.raw().map((value) => this.project(value));
  }
  project({
    id,
    name,
    host,
    port,
    username,
    keyId,
    hostKey,
    hostFingerprint,
    createdAt,
    projectId = null,
    trustSource,
  }) {
    const key = this.keyStore.get(keyId);
    return {
      id,
      name,
      host,
      port,
      username,
      keyId,
      keyName: key.name,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      hostKey,
      hostFingerprint,
      createdAt,
      projectId,
      ...(["existing", "provider", "user"].includes(trustSource) ? { trustSource } : {}),
    };
  }
  rename(id, name) {
    this.catalog.replaceHosts(
      this.raw().map((item) => (item.id === id ? { ...item, name } : item)),
    );
  }
}
