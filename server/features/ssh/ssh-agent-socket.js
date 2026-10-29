// The Unix socket of one session's SSH agent. Every request is authorized against the
// live grants; a signature needs a verified, non-forwarding session-bind on the same
// connection (ssh-agent-policy.js). Refusals answer a bare SSH_AGENT_FAILURE and report
// their code through onDenied only. Nothing here logs or keeps key material.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { clearStaleSocket } from "../../lib/stale-socket.js";
import { privateFolder } from "../../lib/storage.js";
import { signUserauth, verifySessionBind } from "./ssh-agent-keys.js";
import {
  agentIdentities,
  agentRefusalCodes,
  decideSignature,
} from "./ssh-agent-policy.js";
import { AgentFrameReader, agentReply, parseAgentRequest } from "./ssh-agent-protocol.js";
import {
  codedError,
  foldersBetween,
  tokenPattern,
  validSessionId,
} from "./ssh-agent-shared.js";
import { sshPhysicalRoot } from "./ssh-root.js";

const maxBinds = 16;

// 128 random bits naming one agent's socket folder. Kept in the agent record so a
// restart listens at the same path; never derived from the session id, so another
// session cannot compute it.
export function newAgentToken() {
  return randomBytes(16).toString("hex");
}

const maxSocketPath = 100;

function hashOf(value, length) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function defaultWarn(code) {
  console.warn(`SSH agent socket: ${code}`);
}

// Where one agent listens: { root, socketPath, fallback }. Pure: listen() creates
// root and every folder below it with privateFolder.
// - Home layout: ~/.agentpier-ssh/<hash8 of the physical data dir>/<token>/agent.sock.
//   nono's default profile neither lists nor modifies the home folder (R25).
// - When that path is longer than 100 bytes (sun_path is 104 on macOS, 108 on Linux),
//   /tmp/agentpier-sshagent-<uid>-<hash20 of the physical SSH root>/<token>/agent.sock,
//   with the warning SSH_AGENT_SOCKET_TMP_FALLBACK.
export function agentSocketLocation(
  dataDir,
  sessionId,
  token,
  { home = os.homedir(), warn = defaultWarn } = {},
) {
  if (!validSessionId(sessionId))
    throw codedError("SSH_AGENT_SESSION_INVALID", "Invalid session id");
  if (typeof token !== "string" || !tokenPattern.test(token))
    throw codedError("SSH_AGENT_TOKEN_INVALID", "Invalid SSH agent token");
  const sshRoot = sshPhysicalRoot(dataDir);
  if (typeof home === "string" && path.isAbsolute(home)) {
    const root = path.join(path.resolve(home), ".agentpier-ssh");
    const socketPath = path.join(
      root,
      hashOf(path.dirname(sshRoot), 8),
      token,
      "agent.sock",
    );
    if (Buffer.byteLength(socketPath) <= maxSocketPath)
      return { root, socketPath, fallback: false };
  }
  try {
    warn("SSH_AGENT_SOCKET_TMP_FALLBACK");
  } catch {
    // A warning never blocks the agent.
  }
  const root = `/tmp/agentpier-sshagent-${process.getuid?.() ?? "user"}-${hashOf(sshRoot, 20)}`;
  return { root, socketPath: `${root}/${token}/agent.sock`, fallback: true };
}

// The private folders from root down to the socket's folder. Without a root, the two
// folders above the socket, as in the /tmp layout.
function folderChain(socketPath, root) {
  const folder = path.dirname(socketPath);
  return foldersBetween(root ?? path.dirname(folder), folder, () =>
    codedError("SSH_AGENT_SOCKET_UNSAFE", "SSH agent root must contain the socket"),
  );
}

function deniedCode(error, fallback) {
  return agentRefusalCodes.has(error?.code) ? error.code : fallback;
}

// Waits until the socket takes more data or closes; both listeners are removed again.
function writable(socket) {
  return new Promise((resolve) => {
    const done = () => {
      socket.removeListener("drain", done);
      socket.removeListener("close", done);
      resolve();
    };
    socket.on("drain", done);
    socket.on("close", done);
  });
}

export class SessionAgentSocket {
  constructor({
    socketPath,
    root,
    authorize,
    readIdentity,
    onSigned,
    onDenied,
    maxConnections = 32,
    idleMs = 600000,
    maxMessage = 262144,
    maxQueued = 256,
  }) {
    this.socketPath = socketPath;
    this.root = root;
    this.authorize = authorize;
    this.readIdentity = readIdentity;
    this.onSigned = onSigned;
    this.onDenied = onDenied;
    this.maxConnections = maxConnections;
    this.idleMs = idleMs;
    this.maxMessage = maxMessage;
    this.maxQueued = maxQueued;
    this.connections = new Set();
    this.server = null;
    this.closed = false;
  }

  async listen() {
    if (this.closed) throw codedError("SSH_AGENT_CLOSED", "SSH agent closed");
    const unsafe = () => codedError("SSH_AGENT_SOCKET_UNSAFE", "Unsafe SSH agent socket");
    for (const folder of folderChain(this.socketPath, this.root))
      privateFolder(folder, unsafe);
    await clearStaleSocket(this.socketPath, {
      unsafe,
      live: () => codedError("SSH_AGENT_SOCKET_BUSY", "SSH agent socket in use"),
      changed: () => codedError("SSH_AGENT_SOCKET_UNSAFE", "SSH agent socket changed"),
    });
    const server = net.createServer((socket) => this.connection(socket));
    server.maxConnections = this.maxConnections;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    // A later listener error must not crash the server; connections fail on their own.
    server.on("error", () => {});
    if (this.closed) {
      await new Promise((resolve) => server.close(() => resolve()));
      throw codedError("SSH_AGENT_CLOSED", "SSH agent closed");
    }
    this.server = server;
    try {
      fs.chmodSync(this.socketPath, 0o600);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    this.closed = true;
    const server = this.server;
    this.server = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    // Node removes the socket file; the folders stay for a restart at the same path.
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  connection(socket) {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    const state = {
      binding: null,
      forwarded: false,
      reader: new AgentFrameReader({ maxMessage: this.maxMessage }),
      frames: [],
      binds: 0,
      busy: false,
    };
    socket.setTimeout(this.idleMs, () => socket.destroy());
    socket.on("error", () => {});
    socket.once("close", () => {
      this.connections.delete(socket);
      state.frames = [];
    });
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = state.reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) state.frames.push(frame);
      // A client that pipelines more than it reads is cut off, not buffered.
      if (state.frames.length > this.maxQueued) {
        socket.destroy();
        return;
      }
      this.drain(socket, state);
    });
  }

  // Answers one frame at a time, in order. Reading pauses while answers are pending,
  // so a client that pipelines requests holds at most one read chunk in memory.
  async drain(socket, state) {
    if (state.busy) return;
    state.busy = true;
    socket.pause();
    try {
      while (state.frames.length && !socket.destroyed) {
        let answer;
        try {
          answer = await this.answer(state, state.frames.shift());
        } catch {
          answer = agentReply.failure();
        }
        if (socket.destroyed) break;
        if (!socket.write(answer)) await writable(socket);
      }
    } finally {
      state.busy = false;
      if (!socket.destroyed) socket.resume();
    }
  }

  async answer(state, frame) {
    let request;
    try {
      request = parseAgentRequest(frame);
    } catch {
      return agentReply.failure();
    }
    if (request.kind === "identities") return this.identities();
    if (request.kind === "sign") return this.sign(state, request);
    if (request.kind === "session-bind") return this.bind(state, request);
    // Unknown extensions, add, remove, lock and smartcard requests.
    return agentReply.failure();
  }

  denied(code) {
    try {
      this.onDenied(code);
    } catch {
      // Reporting must not change the answer.
    }
    return agentReply.failure();
  }

  async identities() {
    let grant;
    try {
      grant = await this.authorize();
      if (!grant) return agentReply.identities([]);
      return agentReply.identities(agentIdentities(grant.hosts));
    } catch {
      return this.denied("SSH_AGENT_NOT_GRANTED");
    }
  }

  bind(state, request) {
    // A forwarding bind marks the connection for good, verified or not: it never signs.
    if (request.forwarding) state.forwarded = true;
    // Like OpenSSH's agent: nothing rebinds a connection after an authentication bind,
    // and a connection takes at most maxBinds binds.
    state.binds += 1;
    if (state.binding || state.binds > maxBinds) return agentReply.failure();
    const algorithm = verifySessionBind(request);
    if (!algorithm) return agentReply.failure();
    if (!request.forwarding)
      state.binding = {
        sessionId: request.sessionId,
        hostKeyBlob: request.hostKeyBlob,
        forwarding: false,
        algorithm,
      };
    return agentReply.success();
  }

  async sign(state, request) {
    let hosts;
    try {
      hosts = (await this.authorize())?.hosts ?? [];
    } catch {
      return this.denied("SSH_AGENT_NOT_GRANTED");
    }
    const binding = state.forwarded
      ? { ...state.binding, forwarding: true }
      : state.binding;
    const decision = decideSignature({
      binding,
      keyBlob: request.keyBlob,
      data: request.data,
      flags: request.flags,
      hosts,
    });
    if (!decision.ok) return this.denied(decision.code);
    let signature;
    try {
      signature = signUserauth(
        this.readIdentity(decision.host.keyId),
        request.data,
        request.flags,
        { allowSha1: decision.host.legacy, keyBlob: request.keyBlob },
      );
    } catch (error) {
      return this.denied(deniedCode(error, "SSH_AGENT_KEY_UNSUPPORTED"));
    }
    try {
      this.onSigned(decision.host);
    } catch {
      // The audit reports its own failures; the signature is already made.
    }
    return agentReply.signature(signature);
  }
}
