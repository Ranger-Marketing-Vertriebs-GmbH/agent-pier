import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  privateDirectory,
  readJSON,
  writePrivate,
  problem,
  nameValue,
} from "../../lib/storage.js";
import {
  prepareIdentity,
  publicKeyValue,
  validateFields,
  runOpenSsh,
} from "./ssh-keys.js";

const preparations = new WeakMap();

export class SshKeyStore {
  constructor({
    root,
    dataDir,
    catalog,
    run = runOpenSsh,
    accesses = () => [],
    migrate = () => {},
  }) {
    root ||= path.join(path.resolve(dataDir), "ssh");
    this.catalog = catalog;
    this.root = root;
    this.directory = path.join(root, "identities");
    if (catalog || !fs.existsSync(path.join(root, "catalog.json")))
      privateDirectory(this.directory);
    this.file = path.join(root, "keys.json");
    this.run = run;
    this.accesses = accesses;
    this.migrate = migrate;
  }
  raw() {
    return this.catalog
      ? this.catalog.read().keys
      : readJSON(path.join(this.root, "catalog.json"), null)?.keys ||
          readJSON(this.file, []);
  }
  assertWriter() {
    if (!this.catalog && fs.existsSync(path.join(this.root, "catalog.json")))
      throw problem("SSH catalog requires its management service.", 503);
  }
  save(rows) {
    this.assertWriter();
    if (this.catalog) this.catalog.replacePart("keys", rows);
    else writePrivate(this.file, rows);
  }
  identityDirectory(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      throw problem("SSH key not found.", 404);
    return path.join(this.directory, id);
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
    this.migrate();
    return this.raw().map((key) => this.project(key));
  }
  get(id) {
    this.identityDirectory(id);
    const key = this.list().find((key) => key.id === id);
    if (!key) throw problem("SSH key not found.", 404);
    return key;
  }
  async create(input = {}) {
    const prepared = await this.prepare(input);
    try {
      return await this.publish(prepared);
    } finally {
      prepared.cleanup();
    }
  }
  async prepare(input = {}) {
    this.assertWriter();
    validateFields(input, ["name", "privateKey", "projectId"]);
    const name = nameValue(input.name);
    this.migrate();
    const id = randomUUID();
    const directory = privateDirectory(path.join(this.root, "staging", id));
    if (this.catalog)
      fs.writeFileSync(path.join(directory, ".catalog-owned"), "", { mode: 0o600 });
    try {
      const identity = await prepareIdentity(directory, input.privateKey, this.run);
      const key = {
        id,
        name,
        ...identity,
        projectId: input.projectId ?? null,
        createdAt: new Date().toISOString(),
      };
      const state = { key, directory, owner: this, published: false };
      const prepared = {
        ...key,
        cleanup: () => {
          if (!state.published) fs.rmSync(directory, { recursive: true, force: true });
        },
      };
      preparations.set(prepared, state);
      return prepared;
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      if (error.status) throw error;
      throw problem("SSH key could not be saved.");
    }
  }
  publish(prepared) {
    this.assertWriter();
    if (this.catalog) return this.catalog.run(() => this.publishKey(prepared));
    return this.publishKey(prepared);
  }
  publishKey(prepared) {
    const state = preparations.get(prepared);
    if (!state || state.owner !== this || state.published)
      throw problem("Invalid SSH key preparation.", 409);
    const { key, directory } = state;
    const finalDirectory = this.identityDirectory(key.id);
    fs.renameSync(directory, finalDirectory);
    state.published = true;
    if (this.catalog)
      this.catalog.afterRollback(() =>
        fs.rmSync(finalDirectory, { recursive: true, force: true }),
      );
    try {
      this.save([...this.raw(), key]);
      return this.project(key);
    } catch (error) {
      fs.rmSync(finalDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  rename(id, input = {}) {
    this.assertWriter();
    if (this.catalog) return this.catalog.run(() => this.renameKey(id, input));
    return this.renameKey(id, input);
  }
  renameKey(id, input) {
    validateFields(input, ["name"]);
    const name = nameValue(input.name);
    this.get(id);
    this.save(this.raw().map((key) => (key.id === id ? { ...key, name } : key)));
    return this.get(id);
  }
  remove(id) {
    this.assertWriter();
    if (this.catalog) return this.catalog.run(() => this.removeKey(id));
    return this.removeKey(id);
  }
  removeKey(id) {
    const key = this.get(id);
    if (key.hosts.length) throw problem("SSH key is still used by a host.", 409);
    const stored = this.raw().find((key) => key.id === id);
    this.save(this.raw().filter((key) => key.id !== id));
    if (this.catalog) {
      this.catalog.tombstone(id);
      this.catalog.afterCommit(() => this.cleanupIdentity(id, stored));
    } else this.cleanupIdentity(id, stored);
  }
  cleanupIdentity(id, stored) {
    fs.rmSync(this.identityDirectory(id), { recursive: true, force: true });
    for (const hostId of stored.legacyHostIds || []) {
      this.identityDirectory(hostId); // Validate persisted identifiers before resolving paths.
      for (const name of ["identity", "identity.pub"])
        fs.rmSync(path.join(this.root, "keys", hostId, name), { force: true });
    }
  }
  openPrivate(id) {
    this.get(id);
    const directory = this.identityDirectory(id);
    const file = path.join(directory, "identity");
    if (
      fs.realpathSync(directory) !==
      path.join(fs.realpathSync(this.root), "identities", id)
    )
      throw problem("Invalid SSH identity.", 409);
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(fd);
      const current = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid() ||
        stat.size > 65536 ||
        stat.ino !== current.ino ||
        stat.dev !== current.dev
      )
        throw problem("Invalid SSH identity.", 409);
      return { fd, size: stat.size, filename: `ssh-key-${id}.key` };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  migrateAccesses(accesses) {
    let keys = this.raw();
    const migrated = accesses.map((access) => {
      if (access.keyId) return access;
      this.identityDirectory(access.id);
      const publicKey = publicKeyValue(access.publicKey);
      const original = path.join(this.root, "keys", access.id, "identity");
      // Read before writing either JSON file. Missing files fail only SSH operations,
      // leaving the original access record and all existing material untouched.
      const privateKey = fs.readFileSync(original);
      let key = keys.find((key) => key.publicKey === publicKey);
      if (!key) {
        key = {
          id: createHash("sha256")
            .update(publicKey)
            .digest("hex")
            .slice(0, 32)
            .replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5"),
          name: access.name,
          publicKey,
          fingerprint: access.fingerprint,
          createdAt: access.createdAt,
          legacyHostIds: [],
        };
        const directory = privateDirectory(this.identityDirectory(key.id));
        fs.writeFileSync(path.join(directory, "identity"), privateKey, {
          mode: 0o600,
          flag: "w",
        });
        fs.writeFileSync(path.join(directory, "identity.pub"), `${publicKey}\n`, {
          mode: 0o600,
          flag: "w",
        });
        keys = [...keys, key];
      }
      key.legacyHostIds = [...new Set([...(key.legacyHostIds || []), access.id])];
      return { ...access, keyId: key.id };
    });
    // Catalog first: retry after interruption reuses public identities already saved.
    writePrivate(this.file, keys);
    return migrated;
  }
}
