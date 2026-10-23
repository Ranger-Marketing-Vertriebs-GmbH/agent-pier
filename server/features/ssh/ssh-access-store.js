import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
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
  runOpenSsh,
  processOptions,
} from "./ssh-keys.js";

import { SshKeyStore } from "./ssh-key-store.js";
import { SshPasswordStore, passwordValue } from "./ssh-password-store.js";
import { hostTypes, sftpAuths, remoteRootValue } from "./sftp-host-fields.js";
import { sshProblem } from "./ssh-errors.js";
import { openSftp } from "../sftp/sftp-client.js";

// SSH rows keep their original digest; SFTP rows also pin auth, root and credential.
function connectionRevision(row) {
  const { host, port, username, keyId, hostKey } = row;
  const fields = [host, port, username, keyId, hostKey];
  if (row.type === "sftp")
    fields.push(row.type, row.auth, row.remoteRoot, row.credentialRevision);
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
const isSftp = (row) => row?.type === "sftp";

export class SshAccessStore {
  constructor({ dataDir, catalog, run = runOpenSsh }) {
    this.catalog = catalog;
    this.root = path.join(path.resolve(dataDir), "ssh");
    this.keys = path.join(this.root, "keys");
    if (catalog || !fs.existsSync(path.join(this.root, "catalog.json"))) {
      privateDirectory(this.root);
      privateDirectory(this.keys);
    }
    this.file = path.join(this.root, "accesses.json");
    this.run = run;
    this.updates = new Map();
    this.passwords = new SshPasswordStore({ root: this.root });
    this.keyStore = new SshKeyStore({
      root: this.root,
      catalog,
      run,
      accesses: () => this.raw(),
      migrate: () => this.migrate(),
    });
  }
  // SSH rows live in `hosts`, SFTP rows in `sftpHosts`: older releases read only SSH.
  raw() {
    const current = this.catalog
      ? this.catalog.read()
      : readJSON(path.join(this.root, "catalog.json"), null);
    if (!current) return readJSON(this.file, []);
    return [...(current.hosts || []), ...(current.sftpHosts || [])];
  }
  save(rows) {
    this.keyStore.assertWriter();
    if (!this.catalog) return writePrivate(this.file, rows);
    this.catalog.replacePart(
      "hosts",
      rows.filter((row) => !isSftp(row)),
    );
    this.catalog.replacePart("sftpHosts", rows.filter(isSftp));
  }
  row(id) {
    const row = this.raw().find((item) => item.id === id);
    if (!row) throw problem(serverMessages.ssh.accessNotFound, 404);
    return row;
  }
  migrate() {
    if (this.catalog || fs.existsSync(path.join(this.root, "catalog.json"))) return;
    const accesses = readJSON(this.file, []);
    if (!accesses.some((access) => !access.keyId)) return;
    try {
      writePrivate(this.file, this.keyStore.migrateAccesses(accesses));
    } catch {
      throw problem(serverMessages.ssh.migrationFailed, 503);
    }
  }
  list() {
    this.migrate();
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
    type = "ssh",
    auth,
    remoteRoot = null,
    credentialRevision,
  }) {
    const sftp = type === "sftp";
    const key = keyId ? this.keyStore.get(keyId) : null;
    return {
      id,
      name,
      host,
      port,
      username,
      keyId: keyId ?? null,
      keyName: key?.name ?? null,
      publicKey: key?.publicKey ?? null,
      fingerprint: key?.fingerprint ?? null,
      hostKey,
      hostFingerprint,
      createdAt,
      projectId,
      ...(["existing", "provider", "user"].includes(trustSource) ? { trustSource } : {}),
      type: sftp ? "sftp" : "ssh",
      auth: sftp ? auth : "key",
      remoteRoot: sftp ? remoteRoot : null,
      hasPassword: sftp && auth === "password" && Boolean(credentialRevision),
    };
  }
  get(id) {
    const access = this.list().find((item) => item.id === id);
    if (!access) throw problem(serverMessages.ssh.accessNotFound, 404);
    return access;
  }
  directory(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      throw problem(serverMessages.ssh.accessNotFound, 404);
    return path.join(this.keys, id);
  }
  knownHosts(access) {
    const host = access.port === 22 ? access.host : `[${access.host}]:${access.port}`;
    const file = path.join(this.directory(access.id), "known_hosts");
    fs.writeFileSync(file, `${host} ${access.hostKey}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  async create(input = {}) {
    this.keyStore.assertWriter();
    if (this.catalog) return this.catalog.run(() => this.createAccess(input));
    return this.createAccess(input);
  }
  async createAccess(input) {
    validateFields(input, [
      "name",
      "host",
      "port",
      "username",
      "hostKey",
      "privateKey",
      "keyId",
      "projectId",
      "type",
      "auth",
      "password",
      "remoteRoot",
    ]);
    if (input.keyId !== undefined && input.privateKey !== undefined)
      throw problem(serverMessages.ssh.chooseOneKey);
    const sftp = this.sftpFields(input);
    const selected = input.keyId === undefined ? null : this.keyStore.get(input.keyId);
    if (selected && selected.projectId !== (input.projectId ?? null))
      throw problem(serverMessages.ssh.keyInOtherProject, 409);
    const name = nameValue(input.name);
    const target = endpoint(input);
    if (!target.username) throw problem(serverMessages.ssh.invalidUsername);
    const hostKey = publicKeyValue(input.hostKey);
    const hostFingerprint = await fingerprint(hostKey, this.root, this.run);
    const id = randomUUID();
    const directory = privateDirectory(this.directory(id));
    try {
      const key =
        sftp?.auth === "password"
          ? null
          : selected ||
            (await this.keyStore.create({
              name,
              projectId: input.projectId ?? null,
              ...(input.privateKey === undefined ? {} : { privateKey: input.privateKey }),
            }));
      if (key) this.keyStore.get(key.id);
      const access = {
        id,
        name,
        ...target,
        keyId: key?.id ?? null,
        hostKey,
        hostFingerprint,
        createdAt: new Date().toISOString(),
        projectId: input.projectId ?? null,
        ...(sftp && {
          type: "sftp",
          auth: sftp.auth,
          remoteRoot: sftp.remoteRoot,
          credentialRevision: randomUUID(),
        }),
      };
      if (sftp?.password !== undefined) {
        this.catalog.afterRollback(() => this.passwords.removeHost(id));
        this.passwords.write(id, access.credentialRevision, sftp.password);
      }
      if (!this.catalog) this.knownHosts(access);
      else
        this.catalog.afterRollback(() =>
          fs.rmSync(directory, { recursive: true, force: true }),
        );
      this.save([...this.raw(), access]);
      return this.project(access);
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      if (error.status) throw error;
      throw problem(serverMessages.ssh.accessSaveFailed);
    }
  }
  /** Validated SFTP fields of a create request, or null for an SSH host. */
  sftpFields(input) {
    const type = input.type ?? "ssh";
    if (!hostTypes.includes(type)) throw problem(serverMessages.ssh.invalidAccessFields);
    if (type === "ssh") {
      if (input.password !== undefined)
        throw problem(serverMessages.ssh.passwordNotAllowed);
      if (input.remoteRoot !== undefined)
        throw problem(serverMessages.ssh.invalidAccessFields);
      if (input.auth !== undefined && input.auth !== "key")
        throw problem(serverMessages.ssh.invalidAuth);
      return null;
    }
    if (!this.catalog) throw problem(serverMessages.ssh.managementRequired, 503);
    if (!sftpAuths.includes(input.auth)) throw problem(serverMessages.ssh.invalidAuth);
    const remoteRoot = remoteRootValue(input.remoteRoot);
    if (input.auth === "key") {
      if (input.password !== undefined)
        throw problem(serverMessages.ssh.passwordNotAllowed);
      return { auth: "key", remoteRoot };
    }
    if (input.keyId !== undefined || input.privateKey !== undefined)
      throw problem(serverMessages.ssh.invalidAuth);
    if (input.password === undefined || input.password === "")
      throw problem(serverMessages.ssh.passwordRequired);
    return { auth: "password", remoteRoot, password: passwordValue(input.password) };
  }
  update(id, input = {}) {
    this.keyStore.assertWriter();
    if (this.catalog) return this.catalog.run(() => this.updateAccess(id, input));
    const previous = this.updates.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.updateAccess(id, input));
    this.updates.set(id, operation);
    return operation.finally(() => {
      if (this.updates.get(id) === operation) this.updates.delete(id);
    });
  }
  async updateAccess(id, input) {
    validateFields(input, [
      "name",
      "host",
      "port",
      "username",
      "hostKey",
      "keyId",
      "type",
      "auth",
      "password",
      "remoteRoot",
    ]);
    const {
      type,
      auth: _auth,
      remoteRoot: _root,
      hasPassword: _has,
      ...previous
    } = this.get(id);
    if (input.type !== undefined && input.type !== type)
      throw problem(serverMessages.ssh.hostTypeFixed, 409);
    if (type === "sftp") return this.updateSftp(id, input, previous);
    if (input.password !== undefined)
      throw problem(serverMessages.ssh.passwordNotAllowed);
    if (input.remoteRoot !== undefined || (input.auth ?? "key") !== "key")
      throw problem(serverMessages.ssh.invalidAccessFields);
    const keyId =
      input.keyId === undefined ? previous.keyId : this.keyStore.get(input.keyId).id;
    if (this.keyStore.get(keyId).projectId !== previous.projectId)
      throw problem(serverMessages.ssh.keyInOtherProject, 409);
    const target = endpoint({ ...previous, ...input });
    if (!target.username) throw problem(serverMessages.ssh.invalidUsername);
    if (
      (target.host !== previous.host || target.port !== previous.port) &&
      input.hostKey === undefined
    )
      throw problem(serverMessages.ssh.confirmChangedHostKey);
    const hostKey = publicKeyValue(input.hostKey ?? previous.hostKey);
    const access = {
      ...previous,
      keyId,
      ...target,
      name: input.name === undefined ? previous.name : nameValue(input.name),
      hostKey,
      hostFingerprint: await fingerprint(hostKey, this.root, this.run),
    };
    // A concurrent deletion must not resurrect a deleted access.
    this.get(id);
    this.keyStore.get(keyId);
    if (!this.catalog) this.knownHosts(access);
    this.save(this.raw().map((item) => (item.id === id ? access : item)));
    return this.project(access);
  }
  async updateSftp(id, input, previous) {
    const stored = this.row(id);
    const auth = input.auth ?? stored.auth;
    if (!sftpAuths.includes(auth)) throw problem(serverMessages.ssh.invalidAuth);
    let keyId = null;
    if (auth === "key") {
      if (input.password !== undefined)
        throw problem(serverMessages.ssh.passwordNotAllowed);
      keyId = input.keyId === undefined ? stored.keyId : input.keyId;
      if (!keyId) throw problem(serverMessages.ssh.invalidAuth);
      if (this.keyStore.get(keyId).projectId !== previous.projectId)
        throw problem(serverMessages.ssh.keyInOtherProject, 409);
    } else if (input.keyId !== undefined) throw problem(serverMessages.ssh.invalidAuth);
    const password =
      auth === "password" && input.password !== undefined
        ? passwordValue(input.password)
        : undefined;
    if (auth === "password" && stored.auth !== "password" && password === undefined)
      throw problem(serverMessages.ssh.passwordRequired);
    const target = endpoint({ ...previous, ...input });
    if (!target.username) throw problem(serverMessages.ssh.invalidUsername);
    if (
      (target.host !== previous.host || target.port !== previous.port) &&
      input.hostKey === undefined
    )
      throw problem(serverMessages.ssh.confirmChangedHostKey);
    const hostKey = publicKeyValue(input.hostKey ?? previous.hostKey);
    const access = {
      ...stored,
      ...target,
      name: input.name === undefined ? stored.name : nameValue(input.name),
      keyId,
      auth,
      remoteRoot:
        input.remoteRoot === undefined
          ? stored.remoteRoot
          : remoteRootValue(input.remoteRoot),
      hostKey,
      hostFingerprint: await fingerprint(hostKey, this.root, this.run),
      credentialRevision:
        password !== undefined || auth !== stored.auth
          ? randomUUID()
          : stored.credentialRevision,
    };
    // A concurrent deletion must not resurrect a deleted access.
    this.get(id);
    if (keyId) this.keyStore.get(keyId);
    if (password !== undefined) {
      const revision = access.credentialRevision;
      this.catalog.afterRollback(() =>
        fs.rmSync(this.passwords.file(id, revision), { force: true }),
      );
      this.passwords.write(id, revision, password);
    }
    if (access.credentialRevision !== stored.credentialRevision)
      this.catalog.afterCommit(() =>
        this.passwords.removeOthers(id, access.credentialRevision),
      );
    this.save(this.raw().map((item) => (item.id === id ? access : item)));
    return this.project(access);
  }
  remove(id) {
    this.keyStore.assertWriter();
    if (this.catalog) return this.catalog.run(() => this.removeAccess(id));
    return this.removeAccess(id);
  }
  removeAccess(id) {
    const { type } = this.get(id);
    this.save(this.raw().filter((item) => item.id !== id));
    if (this.catalog) {
      this.catalog.tombstone(id);
      this.catalog.afterCommit(() => this.cleanupAccess(id));
      if (type === "sftp") this.catalog.afterCommit(() => this.passwords.removeHost(id));
    } else this.cleanupAccess(id);
  }
  cleanupAccess(id) {
    const directory = this.directory(id);
    fs.rmSync(path.join(directory, "known_hosts"), { force: true });
    if (fs.existsSync(directory) && !fs.readdirSync(directory).length)
      fs.rmdirSync(directory);
  }
  connection(id) {
    const access = this.get(id);
    if (access.type === "sftp")
      throw sshProblem("SSH_HOST_TYPE", serverMessages.ssh.sftpOnly, 409);
    const { host, port, username } = endpoint(access);
    const snapshots = privateDirectory(path.join(this.root, "connections"));
    const directory = fs.mkdtempSync(path.join(snapshots, "invocation-"));
    const pinnedHost = port === 22 ? host : `[${host}]:${port}`;
    fs.writeFileSync(
      path.join(directory, "known_hosts"),
      `${pinnedHost} ${access.hostKey}\n`,
      { mode: 0o600 },
    );
    return {
      revision: connectionRevision(access),
      cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
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
        `../../identities/${access.keyId}/identity`,
        "-p",
        String(port),
        "-l",
        username,
        "--",
        host,
      ],
    };
  }
  revision(id) {
    this.get(id);
    return connectionRevision(this.row(id));
  }
  /** In-process SFTP credentials; never leaves the server process. */
  sftpConnection(id) {
    this.get(id);
    const row = this.row(id);
    if (!isSftp(row))
      throw sshProblem("SSH_HOST_TYPE", serverMessages.ssh.accessNotFound, 404);
    const { host, port, username } = endpoint(row);
    const connection = {
      revision: connectionRevision(row),
      host,
      port,
      username,
      hostKey: row.hostKey,
      remoteRoot: row.remoteRoot ?? null,
    };
    if (row.auth === "password")
      connection.password = this.passwords.read(id, row.credentialRevision);
    else connection.privateKey = this.privateKey(row.keyId);
    return connection;
  }
  privateKey(keyId) {
    const { fd, size } = this.keyStore.openPrivate(keyId);
    try {
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = fs.readSync(fd, buffer, offset, size - offset, null);
        if (!read) break;
        offset += read;
      }
      return buffer.subarray(0, offset);
    } finally {
      fs.closeSync(fd);
    }
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
      throw problem(serverMessages.ssh.hostKeyScanFailed, 502);
    }
  }
  async test(id) {
    if (this.get(id).type === "sftp") return this.testSftp(id);
    const { command, args, cwd, cleanup } = this.connection(id);
    try {
      await this.run(command, [...args, "true"], { ...processOptions, cwd });
      return { ok: true };
    } catch {
      throw problem(serverMessages.ssh.connectionFailed, 502);
    } finally {
      cleanup();
    }
  }
  async testSftp(id) {
    const connection = this.sftpConnection(id);
    let session;
    try {
      session = await openSftp(connection);
      const root = await session.realpath(connection.remoteRoot ?? ".");
      // Some servers resolve missing paths; the allowed folder must exist.
      if ((await session.lstat(root))?.type !== "dir") throw new Error("no folder");
      return { ok: true };
    } catch {
      throw problem(serverMessages.ssh.connectionFailed, 502);
    } finally {
      session?.close();
    }
  }
}
