import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  privateDirectory,
  writePrivate,
  readJSON,
  problem,
  nameValue,
} from "../../lib/storage.js";
import {
  endpoint,
  validateFields,
  publicKeyValue,
  fingerprint,
  prepareIdentity,
  runOpenSsh,
  processOptions,
} from "./ssh-keys.js";

export class SshAccessStore {
  constructor({ dataDir, run = runOpenSsh }) {
    this.root = privateDirectory(path.join(path.resolve(dataDir), "ssh"));
    this.keys = privateDirectory(path.join(this.root, "keys"));
    this.file = path.join(this.root, "accesses.json");
    this.run = run;
    this.updates = new Map();
  }
  list() {
    return readJSON(this.file, []).map((value) => this.project(value));
  }
  project({
    id,
    name,
    host,
    port,
    username,
    publicKey,
    fingerprint,
    hostKey,
    hostFingerprint,
    createdAt,
  }) {
    return {
      id,
      name,
      host,
      port,
      username,
      publicKey,
      fingerprint,
      hostKey,
      hostFingerprint,
      createdAt,
    };
  }
  get(id) {
    const access = this.list().find((item) => item.id === id);
    if (!access) throw problem("SSH access not found.", 404);
    return access;
  }
  directory(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      throw problem("SSH access not found.", 404);
    return path.join(this.keys, id);
  }
  knownHosts(access) {
    const host = access.port === 22 ? access.host : `[${access.host}]:${access.port}`;
    const file = path.join(this.directory(access.id), "known_hosts");
    fs.writeFileSync(file, `${host} ${access.hostKey}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  async create(input = {}) {
    validateFields(input, ["name", "host", "port", "username", "hostKey", "privateKey"]);
    const name = nameValue(input.name);
    const target = endpoint(input);
    if (!target.username) throw problem("Invalid SSH username.");
    const hostKey = publicKeyValue(input.hostKey);
    const hostFingerprint = await fingerprint(hostKey, this.root, this.run);
    const id = randomUUID();
    const directory = privateDirectory(this.directory(id));
    try {
      const identity = await prepareIdentity(directory, input.privateKey, this.run);
      const access = {
        id,
        name,
        ...target,
        ...identity,
        hostKey,
        hostFingerprint,
        createdAt: new Date().toISOString(),
      };
      this.knownHosts(access);
      writePrivate(this.file, [...this.list(), access]);
      return this.project(access);
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      if (error.status) throw error;
      throw problem("SSH access could not be saved.");
    }
  }
  update(id, input = {}) {
    const previous = this.updates.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.updateAccess(id, input));
    this.updates.set(id, operation);
    return operation.finally(() => {
      if (this.updates.get(id) === operation) this.updates.delete(id);
    });
  }
  async updateAccess(id, input) {
    validateFields(input, ["name", "host", "port", "username", "hostKey"]);
    const previous = this.get(id);
    const target = endpoint({ ...previous, ...input });
    if (!target.username) throw problem("Invalid SSH username.");
    if (
      (target.host !== previous.host || target.port !== previous.port) &&
      input.hostKey === undefined
    )
      throw problem("Confirm the SSH host key for the changed endpoint.");
    const hostKey = publicKeyValue(input.hostKey ?? previous.hostKey);
    const access = {
      ...previous,
      ...target,
      name: input.name === undefined ? previous.name : nameValue(input.name),
      hostKey,
      hostFingerprint: await fingerprint(hostKey, this.root, this.run),
    };
    // A concurrent deletion must not resurrect a deleted access.
    this.get(id);
    this.knownHosts(access);
    writePrivate(
      this.file,
      this.list().map((item) => (item.id === id ? access : item)),
    );
    return this.project(access);
  }
  remove(id) {
    this.get(id);
    writePrivate(
      this.file,
      this.list().filter((item) => item.id !== id),
    );
    fs.rmSync(this.directory(id), { recursive: true, force: true });
  }
  connection(id) {
    const access = this.get(id);
    const { host, port, username } = endpoint(access);
    const directory = this.directory(id);
    return {
      command: "ssh",
      cwd: directory,
      args: [
        "-F",
        "/dev/null",
        ...[
          "IdentityAgent=none",
          "IdentitiesOnly=yes",
          "BatchMode=yes",
          "StrictHostKeyChecking=yes",
          "UserKnownHostsFile=known_hosts",
          "GlobalKnownHostsFile=/dev/null",
          "ForwardAgent=no",
          "ControlMaster=no",
          "ControlPath=none",
          "PasswordAuthentication=no",
          "KbdInteractiveAuthentication=no",
          "PreferredAuthentications=publickey",
          "ConnectTimeout=10",
          "ConnectionAttempts=1",
          "UpdateHostKeys=no",
        ].flatMap((option) => ["-o", option]),
        "-i",
        "identity",
        "-p",
        String(port),
        "-l",
        username,
        "--",
        host,
      ],
    };
  }
  async scan(input = {}) {
    validateFields(input, ["host", "port"]);
    const { host, port } = endpoint(input);
    try {
      const { stdout } = await this.run(
        "ssh-keyscan",
        ["-T", "5", "-p", String(port), "-t", "ed25519,ecdsa,rsa", host],
        processOptions,
      );
      const candidates = stdout
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.trim().split(/\s+/).slice(1).join(" "));
      for (const type of [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "ssh-rsa",
      ]) {
        for (const candidate of candidates.filter((key) => key.startsWith(`${type} `))) {
          try {
            const hostKey = publicKeyValue(candidate);
            return {
              hostKey,
              hostFingerprint: await fingerprint(hostKey, this.root, this.run),
            };
          } catch {}
        }
      }
      throw new Error();
    } catch {
      throw problem("SSH host key scan failed.", 502);
    }
  }
  async test(id) {
    const { command, args, cwd } = this.connection(id);
    try {
      await this.run(command, [...args, "true"], { ...processOptions, cwd });
      return { ok: true };
    } catch {
      throw problem(
        "SSH connection failed. Check the endpoint, installed public key and confirmed host key.",
        502,
      );
    }
  }
}
