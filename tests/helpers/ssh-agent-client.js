// A minimal SSH agent protocol client and key fixtures for the session agent tests.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import ssh2 from "ssh2";
import { publicKeyBlob, signUserauth } from "../../server/features/ssh/ssh-agent-keys.js";
import {
  AgentFrameReader,
  encodeFrame,
  WireReader,
  wireString,
} from "../../server/features/ssh/ssh-agent-protocol.js";

const run = promisify(execFile);

export function generateKey(folder, name, type = "ed25519") {
  const file = path.join(folder, name);
  execFileSync("ssh-keygen", ["-q", "-N", "", "-t", type, "-C", "", "-f", file]);
  const [kind, base64] = fs.readFileSync(`${file}.pub`, "utf8").trim().split(/\s+/);
  const publicLine = `${kind} ${base64}`;
  return {
    file,
    privateText: fs.readFileSync(file, "utf8"),
    publicLine,
    blob: publicKeyBlob(publicLine),
  };
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

export function userauth({
  sessionId,
  user = "deploy",
  keyBlob,
  algorithm = "ssh-ed25519",
}) {
  return Buffer.concat([
    wireString(sessionId),
    Buffer.from([50]),
    wireString(user),
    wireString("ssh-connection"),
    wireString("publickey"),
    Buffer.from([1]),
    wireString(algorithm),
    wireString(keyBlob),
  ]);
}

// The host's signature over the SSH session id, as a server sends it in its kex reply.
export function hostSignature(hostKey, sessionId) {
  return signUserauth(hostKey.privateText, sessionId, 0);
}

export function verifyWithPublic(publicLine, data, signatureBlob) {
  const reader = new WireReader(signatureBlob);
  reader.string();
  const raw = reader.string();
  return ssh2.utils.parseKey(publicLine).verify(data, raw) === true;
}

export class AgentClient {
  static connect(socketPath) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once("connect", () => resolve(new AgentClient(socket)));
      socket.once("error", reject);
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.reader = new AgentFrameReader();
    this.waiting = [];
    this.closed = new Promise((resolve) => socket.once("close", resolve));
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const frame of this.reader.push(chunk)) this.waiting.shift()?.resolve(frame);
    });
    socket.once("close", () => {
      for (const waiter of this.waiting.splice(0))
        waiter.reject(new Error("agent closed"));
    });
  }

  send(payload) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.socket.write(encodeFrame(payload));
    });
  }

  async raw(type, body = Buffer.alloc(0)) {
    const reply = await this.send(Buffer.concat([Buffer.from([type]), body]));
    return reply[0];
  }

  async reply(type, body) {
    return this.send(Buffer.concat([Buffer.from([type]), body]));
  }

  async identities() {
    const reply = await this.send(Buffer.from([11]));
    if (reply[0] !== 12) return reply[0];
    const reader = new WireReader(reply, 1);
    const count = reader.u32();
    const list = [];
    for (let i = 0; i < count; i += 1)
      list.push({ keyBlob: reader.string(), comment: reader.string().toString() });
    return list;
  }

  signReply(keyBlob, data, flags = 0) {
    return this.reply(
      13,
      Buffer.concat([wireString(keyBlob), wireString(data), u32(flags)]),
    );
  }

  async signRaw(keyBlob, data, flags = 0) {
    return (await this.signReply(keyBlob, data, flags))[0];
  }

  async sign(keyBlob, data, flags = 0) {
    const reply = await this.signReply(keyBlob, data, flags);
    if (reply[0] !== 14) throw new Error(`sign refused with ${reply[0]}`);
    return new WireReader(reply, 1).string();
  }

  bindRaw({ hostKeyBlob, sessionId, signature, forwarding = false }) {
    return this.raw(
      27,
      Buffer.concat([
        wireString("session-bind@openssh.com"),
        wireString(hostKeyBlob),
        wireString(sessionId),
        wireString(signature),
        Buffer.from([forwarding ? 1 : 0]),
      ]),
    );
  }

  bind({ hostKey, sessionId, forwarding = false }) {
    return this.bindRaw({
      hostKeyBlob: hostKey.blob,
      sessionId,
      signature: hostSignature(hostKey, sessionId),
      forwarding,
    });
  }

  close() {
    this.socket.destroy();
    return this.closed;
  }
}

// Runs the real ssh-add against the agent; never the user's own agent.
export async function sshAdd(socketPath, args) {
  try {
    const { stdout } = await run("ssh-add", args, {
      env: { PATH: process.env.PATH, SSH_AUTH_SOCK: socketPath },
      timeout: 10000,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
