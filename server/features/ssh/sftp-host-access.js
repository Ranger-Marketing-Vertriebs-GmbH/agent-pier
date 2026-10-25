import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { problem, nameValue } from "../../lib/storage.js";
import { endpoint, publicKeyValue, fingerprint } from "./ssh-keys.js";
import { passwordValue } from "./ssh-password-store.js";
import { hostTypes, sftpAuths, remoteRootValue } from "./sftp-host-fields.js";
import { sshProblem } from "./ssh-errors.js";
import { openSftp } from "../sftp/sftp-client.js";
import { isSftpProblem } from "../sftp/sftp-errors.js";
import { withTestOutcome } from "./ssh-test-results.js";

// SFTP rules of SshAccessStore; each function takes the store it works on.
// SSH rows keep their original digest; SFTP rows also pin auth, root and credential.
export function connectionRevision(row) {
  const { host, port, username, keyId, hostKey } = row;
  const fields = [host, port, username, keyId, hostKey];
  if (row.type === "sftp")
    fields.push(row.type, row.auth, row.remoteRoot, row.credentialRevision);
  else {
    // Appended only when on, so hosts without these switches keep their digest.
    if (row.legacyAlgorithms === true) fields.push("legacy-algorithms:ssh-rsa");
    if (row.interactiveShell === true) fields.push("interactive-shell");
  }
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
export const isSftp = (row) => row?.type === "sftp";

/** Validated SFTP fields of a create request, or null for an SSH host. */
export function sftpFields(store, input) {
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
  // The built-in SFTP client already accepts ssh-rsa and needs no console.
  if (input.legacyAlgorithms !== undefined || input.interactiveShell !== undefined)
    throw problem(serverMessages.ssh.invalidAccessFields);
  if (!store.catalog) throw problem(serverMessages.ssh.managementRequired, 503);
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

export async function updateSftp(store, id, input, previous) {
  if (input.legacyAlgorithms !== undefined || input.interactiveShell !== undefined)
    throw problem(serverMessages.ssh.invalidAccessFields);
  const stored = store.row(id);
  const auth = input.auth ?? stored.auth;
  if (!sftpAuths.includes(auth)) throw problem(serverMessages.ssh.invalidAuth);
  let keyId = null;
  if (auth === "key") {
    if (input.password !== undefined)
      throw problem(serverMessages.ssh.passwordNotAllowed);
    keyId = input.keyId === undefined ? stored.keyId : input.keyId;
    if (!keyId) throw problem(serverMessages.ssh.invalidAuth);
    if (store.keyStore.get(keyId).projectId !== previous.projectId)
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
    hostFingerprint: await fingerprint(hostKey, store.root, store.run),
    credentialRevision:
      password !== undefined || auth !== stored.auth
        ? randomUUID()
        : stored.credentialRevision,
  };
  // A concurrent deletion must not resurrect a deleted access.
  store.get(id);
  if (keyId) store.keyStore.get(keyId);
  if (password !== undefined) {
    const revision = access.credentialRevision;
    // The host's stored password stays committed: drop the new revision and marker.
    store.catalog.afterRollback(() => {
      fs.rmSync(store.passwords.file(id, revision), { force: true });
      store.passwords.settle(id);
    });
    store.passwords.write(id, revision, password);
    store.catalog.afterCommit(() => store.passwords.settle(id));
  }
  if (access.credentialRevision !== stored.credentialRevision)
    store.catalog.afterCommit(() =>
      store.passwords.removeOthers(id, access.credentialRevision),
    );
  store.save(store.raw().map((item) => (item.id === id ? access : item)));
  return store.project(access);
}

/** In-process SFTP credentials; never leaves the server process. */
export function sftpConnection(store, id) {
  store.get(id);
  const row = store.row(id);
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
    connection.password = store.passwords.read(id, row.credentialRevision);
  else {
    if (store.project(row).keyMissing) throw problem(serverMessages.ssh.keyNotFound, 409);
    connection.privateKey = readPrivateKey(store.keyStore, row.keyId);
  }
  return connection;
}
function readPrivateKey(keyStore, keyId) {
  const { fd, size } = keyStore.openPrivate(keyId);
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

export async function testSftp(store, id) {
  const connection = sftpConnection(store, id);
  let session;
  try {
    session = await openSftp(connection);
    const root = await session.realpath(connection.remoteRoot ?? ".");
    // Some servers resolve missing paths; the allowed folder must exist.
    if ((await session.lstat(root))?.type !== "dir") throw new Error("no folder");
    return { ok: true };
  } catch (error) {
    // The SFTP client's stable problem code names the cause, never a host or secret.
    const code = isSftpProblem(error) ? error.code : null;
    throw withTestOutcome(problem(serverMessages.ssh.connectionFailed, 502), {
      code,
      hostKeyMismatch: code === "SFTP_HOST_KEY_MISMATCH",
      detail: code,
    });
  } finally {
    session?.close();
  }
}
