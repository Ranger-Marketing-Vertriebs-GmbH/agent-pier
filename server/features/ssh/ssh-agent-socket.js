// The Unix socket of one session's SSH agent. Every request is authorized against the
// live grants; a signature needs a verified, non-forwarding session-bind on the same
// connection (ssh-agent-policy.js). Refusals answer a bare SSH_AGENT_FAILURE and report
// their code through onDenied only. Nothing here logs or keeps key material.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { clearStaleSocket } from "../../lib/stale-socket.js";
import { privateFolder } from "../../lib/storage.js";
import { signUserauth, verifySessionBind } from "./ssh-agent-keys.js";
import { agentIdentities, decideSignature } from "./ssh-agent-policy.js";
import { AgentFrameReader, agentReply, parseAgentRequest } from "./ssh-agent-protocol.js";
import { sshPhysicalRoot } from "./ssh-root.js";

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const tokenPattern = /^[0-9a-f]{32}$/;
const knownCodes = new Set([
  "SSH_AGENT_UNBOUND",
  "SSH_AGENT_FORWARDING",
  "SSH_AGENT_NOT_GRANTED",
  "SSH_AGENT_LEGACY",
  "SSH_AGENT_KEY_UNSUPPORTED",
]);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

// 128 random bits naming one agent's socket folder. Kept in the agent record so a
// restart listens at the same path; never derived from the session id, because
// sandboxed sessions may reach /tmp and must not find another session's agent.
export function newAgentToken() {
  return randomBytes(16).toString("hex");
}

// /tmp/agentpier-sshagent-<uid>-<hash20>/<token>/agent.sock. Pure: listen() creates
// the folders. sun_path is 104 bytes on macOS; this stays under 100.
export function agentSocketPath(dataDir, sessionId, token) {
  if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId))
    throw codedError("SSH_AGENT_SESSION_INVALID", "Invalid session id");
  if (typeof token !== "string" || !tokenPattern.test(token))
    throw codedError("SSH_AGENT_TOKEN_INVALID", "Invalid SSH agent token");
  const hash = createHash("sha256")
    .update(sshPhysicalRoot(dataDir))
    .digest("hex")
    .slice(0, 20);
  const uid = process.getuid?.() ?? "user";
  return `/tmp/agentpier-sshagent-${uid}-${hash}/${token}/agent.sock`;
}

function deniedCode(error, fallback) {
  return knownCodes.has(error?.code) ? error.code : fallback;
}

export class SessionAgentSocket {
  constructor({
    socketPath,
    authorize,
    readIdentity,
    onSigned,
    onDenied,
    maxConnections = 32,
    idleMs = 600000,
    maxMessage = 262144,
  }) {
    this.socketPath = socketPath;
    this.authorize = authorize;
    this.readIdentity = readIdentity;
    this.onSigned = onSigned;
    this.onDenied = onDenied;
    this.maxConnections = maxConnections;
    this.idleMs = idleMs;
    this.maxMessage = maxMessage;
    this.connections = new Set();
    this.server = null;
    this.closed = false;
  }

  async listen() {
    if (this.closed) throw codedError("SSH_AGENT_CLOSED", "SSH agent closed");
    const unsafe = () => codedError("SSH_AGENT_SOCKET_UNSAFE", "Unsafe SSH agent socket");
    const folder = path.dirname(this.socketPath);
    privateFolder(path.dirname(folder), unsafe);
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
      state.frames.push(...frames);
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
        const answer = await this.answer(state, state.frames.shift());
        if (socket.destroyed) break;
        if (!socket.write(answer))
          await new Promise((resolve) => {
            socket.once("drain", resolve);
            socket.once("close", resolve);
          });
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
