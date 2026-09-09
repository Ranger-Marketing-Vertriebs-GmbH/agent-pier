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

export class SshKeyStore {
  constructor({ root, run = runOpenSsh, accesses = () => [], migrate = () => {} }) {
    this.root = root;
    this.directory = privateDirectory(path.join(root, "identities"));
    this.file = path.join(root, "keys.json");
    this.run = run;
    this.accesses = accesses;
    this.migrate = migrate;
  }
  raw() {
    return readJSON(this.file, []);
  }
  identityDirectory(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      throw problem("SSH key not found.", 404);
    return path.join(this.directory, id);
  }
  project({ id, name, publicKey, fingerprint, createdAt }) {
    return {
      id,
      name,
      publicKey,
      fingerprint,
      createdAt,
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
    validateFields(input, ["name", "privateKey"]);
    const name = nameValue(input.name);
    this.migrate();
    const id = randomUUID();
    const directory = privateDirectory(this.identityDirectory(id));
    try {
      const identity = await prepareIdentity(directory, input.privateKey, this.run);
      const key = { id, name, ...identity, createdAt: new Date().toISOString() };
      writePrivate(this.file, [...this.raw(), key]);
      return this.project(key);
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      if (error.status) throw error;
      throw problem("SSH key could not be saved.");
    }
  }
  rename(id, input = {}) {
    validateFields(input, ["name"]);
    const name = nameValue(input.name);
    this.get(id);
    writePrivate(
      this.file,
      this.raw().map((key) => (key.id === id ? { ...key, name } : key)),
    );
    return this.get(id);
  }
  remove(id) {
    const key = this.get(id);
    if (key.hosts.length) throw problem("SSH key is still used by a host.", 409);
    const stored = this.raw().find((key) => key.id === id);
    writePrivate(
      this.file,
      this.raw().filter((key) => key.id !== id),
    );
    fs.rmSync(this.identityDirectory(id), { recursive: true, force: true });
    for (const hostId of stored.legacyHostIds || []) {
      this.identityDirectory(hostId); // Validate persisted identifiers before resolving paths.
      for (const name of ["identity", "identity.pub"])
        fs.rmSync(path.join(this.root, "keys", hostId, name), { force: true });
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
