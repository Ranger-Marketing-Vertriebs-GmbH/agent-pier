import { PassThrough } from "node:stream";
import ssh2 from "ssh2";
import { isSftpProblem, sftpProblem } from "./sftp-errors.js";

// Pure-JS SFTP client: credentials stay in this process (no argv, env or helper
// process) and the server must present exactly the pinned host key.
const { Client } = ssh2;
const { STATUS_CODE } = ssh2.utils.sftp;
const HOST_KEY_ALGORITHMS = { "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] };
const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "EPIPE",
]);

function pinnedKey(line) {
  const [type = "", base64 = ""] = String(line || "")
    .trim()
    .split(/\s+/);
  const blob = Buffer.from(base64, "base64");
  const length = Buffer.byteLength(type);
  if (!type || blob.length < 4 + length || blob.readUInt32BE(0) !== length) return null;
  if (blob.subarray(4, 4 + length).toString("latin1") !== type) return null;
  return { type, blob };
}

function connectProblem(error, hostRejected) {
  if (isSftpProblem(error)) return error;
  if (hostRejected) return sftpProblem("SFTP_HOST_KEY_MISMATCH");
  if (error?.level === "client-authentication") return sftpProblem("SFTP_AUTH_FAILED");
  if (error?.level === "client-timeout" || error?.code === "ETIMEDOUT")
    return sftpProblem("SFTP_TIMEOUT");
  if (UNREACHABLE.has(error?.code)) return sftpProblem("SFTP_UNREACHABLE");
  if (error?.level === "handshake" && /host key/i.test(String(error?.message)))
    return sftpProblem("SFTP_HOST_KEY_MISMATCH");
  return sftpProblem("SFTP_FAILED");
}

function authMethods({ username, password, privateKey }) {
  if (privateKey) return [{ type: "publickey", username, key: privateKey }];
  if (typeof password !== "string" || !password) return [];
  let answered = false;
  return [
    { type: "password", username, password },
    {
      type: "keyboard-interactive",
      username,
      // Answer only a lone hidden prompt, and only once; anything else stays empty.
      prompt(_name, _instructions, _language, prompts, finish) {
        const single = prompts.length === 1 && !prompts[0].echo && !answered;
        if (single) answered = true;
        finish(prompts.map(() => (single ? password : "")));
      },
    },
  ];
}

function entryType(attrs) {
  if (attrs?.isSymbolicLink?.()) return "link";
  if (attrs?.isDirectory?.()) return "dir";
  if (attrs?.isFile?.()) return "file";
  return "other";
}

function metadata(attrs) {
  return {
    type: entryType(attrs),
    size: Number(attrs?.size || 0),
    mtimeMs: Number(attrs?.mtime || 0) * 1000,
  };
}

class SftpSession {
  #client;
  #sftp;
  #idleMs;
  #signal;
  #onAbort;
  #reason = null;
  #pending = new Set();
  #streams = new Map();

  constructor(client, sftp, { signal, idleMs }) {
    this.#client = client;
    this.#sftp = sftp;
    this.#idleMs = idleMs;
    this.#signal = signal;
    this.#onAbort = () => this.#shut("SFTP_CANCELLED");
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    const lost = () => this.#shut("SFTP_UNREACHABLE");
    client.on("close", lost);
    client.on("end", lost);
    client.on("error", lost);
    sftp.on("close", lost);
    if (signal?.aborted) this.#onAbort();
  }

  get closed() {
    return this.#reason !== null;
  }

  #shut(code) {
    if (this.#reason) return;
    this.#reason = code;
    this.#signal?.removeEventListener("abort", this.#onAbort);
    for (const fail of this.#pending) fail(sftpProblem(code));
    this.#pending.clear();
    // A destroyed stream may never emit "close" once the channel is gone.
    for (const [stream, disarm] of this.#streams) {
      disarm();
      stream.destroy(sftpProblem(code));
    }
    this.#streams.clear();
    this.#client.destroy();
  }

  #problem(error) {
    if (this.#reason) return sftpProblem(this.#reason);
    if (isSftpProblem(error)) return error;
    if (error?.code === STATUS_CODE.NO_SUCH_FILE) return sftpProblem("SFTP_NOT_FOUND");
    if (error?.code === STATUS_CODE.PERMISSION_DENIED)
      return sftpProblem("SFTP_PERMISSION");
    return sftpProblem("SFTP_FAILED");
  }

  #call(run) {
    if (this.#reason) return Promise.reject(sftpProblem(this.#reason));
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (error, value) => {
        if (!this.#pending.delete(finish)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      this.#pending.add(finish);
      timer = setTimeout(() => {
        finish(sftpProblem("SFTP_TIMEOUT"));
        this.#shut("SFTP_TIMEOUT");
      }, this.#idleMs);
      try {
        run((error, value) => finish(error ? this.#problem(error) : null, value));
      } catch (error) {
        finish(this.#problem(error));
      }
    });
  }

  // Arms the idle timer only while a request waits on the server, so a paused
  // consumer never counts as an unresponsive host.
  #watch(stream, readable) {
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.#shut("SFTP_TIMEOUT");
        stream.destroy(sftpProblem("SFTP_TIMEOUT"));
      }, this.#idleMs);
    };
    const disarm = () => clearTimeout(timer);
    if (readable) {
      const read = stream._read;
      const push = stream.push;
      stream._read = function (size) {
        arm();
        return read.call(this, size);
      };
      stream.push = function (...args) {
        disarm();
        return push.apply(this, args);
      };
    } else {
      for (const name of ["_write", "_writev"]) {
        const write = stream[name];
        stream[name] = function (...args) {
          const done = args.pop();
          arm();
          return write.call(this, ...args, (error) => {
            disarm();
            done(error);
          });
        };
      }
    }
    stream.prependListener("error", (error) => {
      if (isSftpProblem(error)) return;
      const problem = this.#problem(error);
      Object.assign(error, { code: problem.code, status: problem.status });
    });
    const release = () => {
      disarm();
      this.#streams.delete(stream);
    };
    stream.once("close", release);
    stream.once("error", release);
    this.#streams.set(stream, disarm);
    return stream;
  }

  #stream(create, readable) {
    if (this.#reason) {
      const stream = new PassThrough();
      stream.destroy(sftpProblem(this.#reason));
      return stream;
    }
    return this.#watch(create(), readable);
  }

  realpath(remote) {
    return this.#call((done) => this.#sftp.realpath(remote, done));
  }

  async lstat(remote) {
    try {
      return metadata(await this.#call((done) => this.#sftp.lstat(remote, done)));
    } catch (error) {
      if (error.code === "SFTP_NOT_FOUND") return null;
      throw error;
    }
  }

  async readdir(remote) {
    const list = await this.#call((done) => this.#sftp.readdir(remote, done));
    return list
      .filter(({ filename }) => filename !== "." && filename !== "..")
      .map(({ filename, attrs }) => ({ name: filename, ...metadata(attrs) }));
  }

  async mkdir(remote) {
    await this.#call((done) => this.#sftp.mkdir(remote, done));
  }

  async rename(from, to, { overwrite = false } = {}) {
    await this.#call((done) =>
      overwrite
        ? this.#sftp.ext_openssh_rename(from, to, done)
        : this.#sftp.rename(from, to, done),
    );
  }

  async unlink(remote) {
    await this.#call((done) => this.#sftp.unlink(remote, done));
  }

  async rmdir(remote) {
    await this.#call((done) => this.#sftp.rmdir(remote, done));
  }

  async setTimes(remote, mtimeMs) {
    const seconds = Math.floor(Number(mtimeMs) / 1000);
    await this.#call((done) => this.#sftp.utimes(remote, seconds, seconds, done));
  }

  readStream(remote) {
    return this.#stream(() => this.#sftp.createReadStream(remote), true);
  }

  writeStream(remote) {
    return this.#stream(() => this.#sftp.createWriteStream(remote), false);
  }

  close() {
    this.#shut("SFTP_CANCELLED");
  }
}

export function openSftp(connection, { signal, connectMs = 10000, idleMs = 60000 } = {}) {
  if (signal?.aborted) return Promise.reject(sftpProblem("SFTP_CANCELLED"));
  const pin = pinnedKey(connection?.hostKey);
  if (!pin) return Promise.reject(sftpProblem("SFTP_HOST_KEY_MISMATCH"));
  return new Promise((resolve, reject) => {
    const client = new Client();
    let hostRejected = false;
    let settled = false;
    const finish = (error, session) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        client.destroy();
        reject(error);
      } else resolve(session);
    };
    const onAbort = () => finish(sftpProblem("SFTP_CANCELLED"));
    const timer = setTimeout(() => finish(sftpProblem("SFTP_TIMEOUT")), connectMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    client.on("error", (error) => finish(connectProblem(error, hostRejected)));
    client.on("close", () =>
      finish(sftpProblem(hostRejected ? "SFTP_HOST_KEY_MISMATCH" : "SFTP_UNREACHABLE")),
    );
    client.on("ready", () =>
      client.sftp((error, sftp) => {
        if (error) return finish(sftpProblem("SFTP_FAILED"));
        if (settled) return client.destroy();
        finish(null, new SftpSession(client, sftp, { signal, idleMs }));
      }),
    );
    const methods = authMethods(connection);
    try {
      client.connect({
        host: connection.host,
        port: connection.port || 22,
        username: connection.username,
        readyTimeout: connectMs,
        keepaliveInterval: 0,
        algorithms: { serverHostKey: HOST_KEY_ALGORITHMS[pin.type] || [pin.type] },
        hostVerifier: (key) => {
          const trusted = Buffer.isBuffer(key) && key.equals(pin.blob);
          hostRejected = !trusted;
          return trusted;
        },
        authHandler: (methodsLeft) => {
          while (methods.length) {
            const method = methods.shift();
            if (!methodsLeft || methodsLeft.includes(method.type)) return method;
          }
          return false;
        },
      });
    } catch {
      finish(sftpProblem("SFTP_FAILED"));
    }
  });
}
