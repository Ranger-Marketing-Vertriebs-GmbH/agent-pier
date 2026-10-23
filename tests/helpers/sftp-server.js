import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";

// In-process SFTP server for tests: a temp directory is served as "/". It only
// listens on 127.0.0.1 and never touches tmux, real hosts or user files.
const { utils } = ssh2;
const { STATUS_CODE, flagsToString } = utils.sftp;

// ssh2 occasionally writes an ed25519 key its own parser rejects; retry those.
export function sshKeyPair() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pair = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error("Could not generate a parsable ed25519 key.");
}

function publicLine(key) {
  return key.public.split(/\s+/).slice(0, 2).join(" ");
}

function statusCode(status) {
  if (typeof status === "number") return status;
  const code = STATUS_CODE[status];
  if (code === undefined) throw new TypeError(`Unknown SFTP status ${status}`);
  return code;
}

function fsStatus(error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
    return STATUS_CODE.NO_SUCH_FILE;
  if (error?.code === "EACCES" || error?.code === "EPERM")
    return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function attrs(stat) {
  return {
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function readStrings(buffer) {
  const strings = [];
  let offset = 0;
  while (buffer && offset + 4 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    strings.push(buffer.subarray(offset + 4, offset + 4 + length).toString("utf8"));
    offset += 4 + length;
  }
  return strings;
}

// ssh2's server answers INIT without extensions; advertise posix-rename like OpenSSH.
function advertisePosixRename(sftp) {
  const protocol = sftp._protocol;
  if (protocol.agentpierVersionPatched) return;
  protocol.agentpierVersionPatched = true;
  const channelData = protocol.channelData.bind(protocol);
  const name = Buffer.from("posix-rename@openssh.com");
  protocol.channelData = (id, data) => {
    if (data?.length === 9 && data[4] === 2) {
      const body = Buffer.alloc(5 + 4 + name.length + 4 + 1);
      body[0] = 2;
      body.writeUInt32BE(3, 1);
      body.writeUInt32BE(name.length, 5);
      name.copy(body, 9);
      body.writeUInt32BE(1, 9 + name.length);
      body.write("1", 13 + name.length);
      const packet = Buffer.alloc(4 + body.length);
      packet.writeUInt32BE(body.length, 0);
      body.copy(packet, 4);
      return channelData(id, packet);
    }
    return channelData(id, data);
  };
}

export async function startSftpServer({
  users = { deploy: { password: "pw-secret" } },
  keyboardInteractive = false,
  chroot = true,
  posixRename = true,
} = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-sftp-")),
  );
  const hostPair = sshKeyPair();
  const otherPair = sshKeyPair();
  const clients = new Set();
  const failures = new Map();
  const stalls = new Set();
  const log = [];
  let attempts = 0;
  let dropAt = Infinity;
  let transferred = 0;

  if (!chroot)
    for (const name of Object.keys(users))
      await fs.mkdir(path.join(root, "home", name), { recursive: true });

  function authenticate(ctx) {
    attempts += 1;
    const user = Object.hasOwn(users, ctx.username) ? users[ctx.username] : null;
    const allowed = keyboardInteractive
      ? ["keyboard-interactive", "publickey"]
      : ["password", "publickey"];
    if (!user || !allowed.includes(ctx.method)) return ctx.reject(allowed);
    if (ctx.method === "password")
      return user.password && ctx.password === user.password
        ? ctx.accept()
        : ctx.reject(allowed);
    if (ctx.method === "keyboard-interactive")
      return ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) =>
        user.password && answers[0] === user.password
          ? ctx.accept()
          : ctx.reject(allowed),
      );
    const key = user.publicKey ? utils.parseKey(user.publicKey) : null;
    if (
      !key ||
      key instanceof Error ||
      ctx.key.algo !== key.type ||
      !ctx.key.data.equals(key.getPublicSSH())
    )
      return ctx.reject(allowed);
    if (!ctx.signature) return ctx.accept();
    return key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true
      ? ctx.accept()
      : ctx.reject(allowed);
  }

  function serve(client, sftp, username) {
    const home = chroot ? "/" : `/home/${username}`;
    const handles = new Map();
    let nextHandle = 0;
    const local = (remote) =>
      path.join(root, path.posix.resolve(home, String(remote || ".")).slice(1));
    const virtual = (remote) => path.posix.resolve(home, String(remote || "."));
    const count = (bytes) => {
      transferred += bytes;
      if (transferred >= dropAt) {
        dropAt = Infinity;
        client._sock?.destroy();
        return true;
      }
      return false;
    };
    const handleId = (entry) => {
      const id = Buffer.alloc(4);
      id.writeUInt32BE(nextHandle++);
      handles.set(id.toString("hex"), entry);
      return id;
    };
    const handleOf = (id) => handles.get(Buffer.from(id).toString("hex"));
    client.once("close", () => {
      for (const entry of handles.values()) entry.file?.close().catch(() => {});
      handles.clear();
    });
    const on = (op, handler) =>
      sftp.on(op, (reqid, ...args) => {
        const name =
          op === "EXTENDED" && args[0] === "posix-rename@openssh.com" ? args[0] : op;
        log.push(name);
        if (stalls.delete(op)) return;
        if (failures.has(op)) {
          const status = failures.get(op);
          failures.delete(op);
          return sftp.status(reqid, status);
        }
        // Like many servers, the status text names the path that failed.
        Promise.resolve(handler(reqid, ...args)).catch((error) =>
          sftp.status(reqid, fsStatus(error), String(error?.message || "")),
        );
      });

    on("REALPATH", (reqid, remote) =>
      sftp.name(reqid, [{ filename: virtual(remote), longname: "", attrs: {} }]),
    );
    on("STAT", async (reqid, remote) =>
      sftp.attrs(reqid, attrs(await fs.stat(local(remote)))),
    );
    on("LSTAT", async (reqid, remote) =>
      sftp.attrs(reqid, attrs(await fs.lstat(local(remote)))),
    );
    on("SETSTAT", async (reqid, remote, set) => {
      if (set.mtime !== undefined) await fs.utimes(local(remote), set.atime, set.mtime);
      sftp.status(reqid, STATUS_CODE.OK);
    });
    on("OPEN", async (reqid, remote, flags) => {
      const file = await fs.open(local(remote), flagsToString(flags));
      sftp.handle(reqid, handleId({ file, path: local(remote) }));
    });
    on("READ", async (reqid, id, offset, length) => {
      const entry = handleOf(id);
      if (!entry?.file) return sftp.status(reqid, STATUS_CODE.FAILURE);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await entry.file.read(buffer, 0, length, offset);
      if (!bytesRead) return sftp.status(reqid, STATUS_CODE.EOF);
      if (count(bytesRead)) return;
      sftp.data(reqid, buffer.subarray(0, bytesRead));
    });
    on("WRITE", async (reqid, id, offset, data) => {
      const entry = handleOf(id);
      if (!entry?.file) return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (count(data.length)) return;
      await entry.file.write(data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    });
    on("FSTAT", async (reqid, id) => {
      const entry = handleOf(id);
      if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
      sftp.attrs(reqid, attrs(await fs.stat(entry.path)));
    });
    on("FSETSTAT", async (reqid, id, set) => {
      const entry = handleOf(id);
      if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (set.mtime !== undefined) await fs.utimes(entry.path, set.atime, set.mtime);
      sftp.status(reqid, STATUS_CODE.OK);
    });
    on("CLOSE", async (reqid, id) => {
      const key = Buffer.from(id).toString("hex");
      const entry = handles.get(key);
      if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
      handles.delete(key);
      await entry.file?.close();
      sftp.status(reqid, STATUS_CODE.OK);
    });
    on("OPENDIR", async (reqid, remote) => {
      const directory = local(remote);
      const names = await fs.readdir(directory);
      sftp.handle(reqid, handleId({ path: directory, names, done: false }));
    });
    on("READDIR", async (reqid, id) => {
      const entry = handleOf(id);
      if (!entry?.names) return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (entry.done) return sftp.status(reqid, STATUS_CODE.EOF);
      entry.done = true;
      const names = [];
      for (const filename of [".", "..", ...entry.names]) {
        const stat = await fs.lstat(path.join(entry.path, filename));
        names.push({ filename, longname: filename, attrs: attrs(stat) });
      }
      sftp.name(reqid, names);
    });
    on("MKDIR", async (reqid, remote) => {
      await fs.mkdir(local(remote));
      sftp.status(reqid, STATUS_CODE.OK);
    });
    on("RMDIR", async (reqid, remote) => {
      await fs.rmdir(local(remote));
      sftp.status(reqid, STATUS_CODE.OK);
    });
    on("REMOVE", async (reqid, remote) => {
      await fs.unlink(local(remote));
      sftp.status(reqid, STATUS_CODE.OK);
    });
    on("RENAME", async (reqid, from, to) => {
      // Like OpenSSH: a plain RENAME never replaces an existing target.
      const exists = await fs.lstat(local(to)).then(
        () => true,
        () => false,
      );
      if (exists) return sftp.status(reqid, STATUS_CODE.FAILURE);
      await fs.rename(local(from), local(to));
      sftp.status(reqid, STATUS_CODE.OK);
    });
    on("READLINK", async (reqid, remote) => {
      const target = await fs.readlink(local(remote));
      sftp.name(reqid, [{ filename: target, longname: "", attrs: {} }]);
    });
    on("EXTENDED", async (reqid, name, data) => {
      if (!posixRename || name !== "posix-rename@openssh.com")
        return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
      const [from, to] = readStrings(data);
      await fs.rename(local(from), local(to));
      sftp.status(reqid, STATUS_CODE.OK);
    });
  }

  const server = new ssh2.Server({ hostKeys: [hostPair.private] }, (client) => {
    clients.add(client);
    let username = "";
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      username = ctx.username;
      authenticate(ctx);
    });
    client.on("session", (accept) => {
      accept().on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        if (posixRename) advertisePosixRename(sftp);
        serve(client, sftp, username);
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    host: "127.0.0.1",
    port: server.address().port,
    hostKey: publicLine(hostPair),
    otherHostKey: publicLine(otherPair),
    root,
    authAttempts: () => attempts,
    ops: () => [...log],
    dropAfterBytes(bytes) {
      transferred = 0;
      dropAt = bytes;
    },
    failNext(op, status = "FAILURE") {
      failures.set(String(op).toUpperCase(), statusCode(status));
    },
    stallNext(op) {
      stalls.add(String(op).toUpperCase());
    },
    async close() {
      for (const client of clients) client._sock?.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
