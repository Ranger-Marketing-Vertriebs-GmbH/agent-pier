import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { privateDirectory, problem } from "../../lib/storage.js";

const MAX_BYTES = 1024;
const identifier = /^[0-9a-f-]{36}$/;
const pending = ".pending";

/** A login password: 1-1024 UTF-8 bytes, no NUL, CR or LF. */
export function passwordValue(raw, message = serverMessages.ssh.invalidPassword) {
  if (
    typeof raw !== "string" ||
    !raw ||
    Buffer.byteLength(raw) > MAX_BYTES ||
    /[\0\r\n]/.test(raw)
  )
    throw problem(message);
  return raw;
}

function syncDirectory(directory) {
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* Some filesystems do not support directory synchronization. */
  }
}

const sshMessages = {
  notFound: serverMessages.ssh.accessNotFound,
  unavailable: serverMessages.ssh.passwordUnavailable,
  invalid: serverMessages.ssh.invalidPassword,
};

/**
 * SFTP passwords live like SSH keys: one 0600 file per credential revision in
 * `ssh/passwords/<hostId>/<revision>`, owned by this user, never followed through links.
 * Email accounts use the same store under `mail/` with their own `messages`.
 */
export class SshPasswordStore {
  constructor({ root, messages = sshMessages }) {
    this.root = root;
    this.directory = path.join(root, "passwords");
    this.messages = { ...sshMessages, ...messages };
  }
  hostDirectory(hostId) {
    if (typeof hostId !== "string" || !identifier.test(hostId))
      throw problem(this.messages.notFound, 404);
    return path.join(this.directory, hostId);
  }
  file(hostId, revision) {
    const directory = this.hostDirectory(hostId);
    if (typeof revision !== "string" || !identifier.test(revision))
      throw problem(this.messages.unavailable, 409);
    return path.join(directory, revision);
  }
  ownDirectory(directory) {
    let stat;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat && (!stat.isDirectory() || stat.uid !== process.getuid()))
      throw problem(this.messages.unavailable, 409);
    privateDirectory(directory);
  }
  // Refuses a linked or replaced directory, so a file never lands outside the store.
  assertDirectory(hostId) {
    const directory = this.hostDirectory(hostId);
    if (
      fs.realpathSync(directory) !==
      path.join(fs.realpathSync(this.root), "passwords", hostId)
    )
      throw problem(this.messages.unavailable, 409);
  }
  write(hostId, revision, password) {
    const value = Buffer.from(passwordValue(password, this.messages.invalid));
    const file = this.file(hostId, revision);
    // Check before chmod: privateDirectory would follow a planted link.
    this.ownDirectory(this.directory);
    this.ownDirectory(path.dirname(file));
    this.assertDirectory(hostId);
    this.markPending(hostId);
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, value);
      fs.fsyncSync(fd);
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    syncDirectory(path.dirname(file));
  }
  read(hostId, revision) {
    const file = this.file(hostId, revision);
    let fd;
    try {
      this.assertDirectory(hostId);
      fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid() ||
        stat.nlink !== 1 ||
        stat.size > MAX_BYTES ||
        stat.mode & 0o077
      )
        throw new Error("refused");
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const read = fs.readSync(fd, buffer, offset, stat.size - offset, offset);
        if (!read) break;
        offset += read;
      }
      return passwordValue(
        buffer.subarray(0, offset).toString("utf8"),
        this.messages.invalid,
      );
    } catch {
      throw problem(this.messages.unavailable, 409);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  // A host directory holds `.pending` from a password write until its catalog commit,
  // so startup can tell a crashed write from a committed password.
  markPending(hostId) {
    const fd = fs.openSync(
      path.join(this.hostDirectory(hostId), pending),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.closeSync(fd);
  }
  /** Marks the host's passwords as committed; called after the catalog commit. */
  settle(hostId) {
    fs.rmSync(path.join(this.hostDirectory(hostId), pending), { force: true });
  }
  /**
   * Removes password directories of uncommitted writes (no host in the catalog and
   * still `.pending`) and settles the markers of hosts the catalog has. A committed
   * password is never removed here, even when the catalog was lost.
   */
  removeOrphans(hostIds) {
    if (!fs.existsSync(this.directory)) return;
    const owned = new Set(hostIds);
    for (const name of fs.readdirSync(this.directory)) {
      if (!identifier.test(name)) continue;
      const directory = path.join(this.directory, name);
      if (owned.has(name)) this.settle(name);
      else if (fs.existsSync(path.join(directory, pending)))
        fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  removeHost(hostId) {
    fs.rmSync(this.hostDirectory(hostId), { recursive: true, force: true });
  }
  removeOthers(hostId, keepRevision) {
    const directory = this.hostDirectory(hostId);
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory))
      if (name !== keepRevision)
        fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  }
}
