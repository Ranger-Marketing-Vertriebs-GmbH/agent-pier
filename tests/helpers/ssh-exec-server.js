import { spawn } from "node:child_process";
import net from "node:net";
import ssh2 from "ssh2";
import { sshKeyPair } from "./sftp-server.js";

// In-process SSH server for tests with a real OpenSSH client: publickey auth only, for
// the given users and keys; `exec` requests run through `/bin/sh -c` in `cwd`;
// `direct-tcpip` only to 127.0.0.1. Pseudo-terminals, shells, remote forwards and
// agent forwarding are refused unless asked for. It listens on 127.0.0.1 only.
const { utils } = ssh2;

// SSH agent message numbers (draft-miller-ssh-agent).
const agentMessages = { failure: 5, requestIdentities: 11, identities: 12, sign: 13 };

function frame(type, body = Buffer.alloc(0)) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, body]);
}

function sshString(buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([head, buffer]);
}

// Reads whole agent frames from a channel, one per call.
function frameReader(stream) {
  let pending = Buffer.alloc(0);
  const waiting = [];
  const frames = [];
  const settle = () => {
    while (waiting.length && frames.length) waiting.shift().resolve(frames.shift());
  };
  stream.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const length = pending.readUInt32BE(0);
      frames.push(pending.subarray(4, 4 + length));
      pending = pending.subarray(4 + length);
    }
    settle();
  });
  stream.on("close", () => {
    for (const entry of waiting.splice(0)) entry.reject(new Error("agent closed"));
  });
  return () =>
    new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      settle();
    });
}

// Opens an `auth-agent@openssh.com` channel to the client, as a forwarding server
// does (ssh2 has the protocol message but no public method on the server side).
function openAgentChannel(client) {
  return new Promise((resolve, reject) => {
    const wrapper = (error, stream) => (error ? reject(error) : resolve(stream));
    wrapper.type = "auth-agent@openssh.com";
    const id = client._chanMgr.add(wrapper);
    if (id === -1) return reject(new Error("No free channels available"));
    client._protocol.openssh_authAgent(id, 2 * 1024 * 1024, 32 * 1024);
  });
}

// Uses the forwarded agent like a remote host would: list keys, then ask for a
// signature with the first one. Returns the reply types.
async function probeForwardedAgent(client) {
  const stream = await openAgentChannel(client);
  const next = frameReader(stream);
  try {
    stream.write(frame(agentMessages.requestIdentities));
    const identities = await next();
    const result = { identities: identities[0], sign: null };
    if (identities[0] === agentMessages.identities && identities.readUInt32BE(1) > 0) {
      const blob = identities.subarray(9, 9 + identities.readUInt32BE(5));
      const flags = Buffer.alloc(4);
      stream.write(
        frame(
          agentMessages.sign,
          Buffer.concat([sshString(blob), sshString(Buffer.from("remote")), flags]),
        ),
      );
      result.sign = (await next())[0];
    }
    return result;
  } finally {
    stream.end();
  }
}

function parsedKeys(lines) {
  return lines.map((line) => {
    const key = utils.parseKey(line);
    if (key instanceof Error) throw key;
    return key;
  });
}

/**
 * Starts the server. `forwardAgent: true` accepts agent forwarding and, before each
 * command, probes the forwarded agent (results in `agentProbes`).
 */
export async function startExecServer({
  authorizedKeys,
  users = ["deploy"],
  cwd,
  forwardAgent = false,
}) {
  const keys = parsedKeys(authorizedKeys);
  const hostPair = sshKeyPair();
  const execs = [];
  const logins = [];
  const agentProbes = [];
  const clients = new Set();
  const children = new Set();
  const sockets = new Set();

  function authenticate(ctx) {
    if (ctx.method !== "publickey" || !users.includes(ctx.username))
      return ctx.reject(["publickey"]);
    const key = keys.find(
      (item) => ctx.key.algo === item.type && ctx.key.data.equals(item.getPublicSSH()),
    );
    if (!key) return ctx.reject(["publickey"]);
    if (!ctx.signature) return ctx.accept();
    if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)
      return ctx.reject(["publickey"]);
    logins.push(ctx.username);
    return ctx.accept();
  }

  function run(client, accept, info, forwarded) {
    const channel = accept();
    execs.push(info.command);
    const start = async () => {
      if (forwarded)
        agentProbes.push(await probeForwardedAgent(client).catch(() => null));
      const child = spawn("/bin/sh", ["-c", info.command], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.stdin.on("error", () => {});
      channel.on("data", (chunk) => child.stdin.write(chunk));
      channel.on("end", () => child.stdin.end());
      channel.on("close", () => child.kill("SIGTERM"));
      child.stdout.on("data", (chunk) => channel.write(chunk));
      child.stderr.on("data", (chunk) => channel.stderr.write(chunk));
      child.on("close", (code, signal) => {
        children.delete(child);
        if (channel.destroyed) return;
        if (signal) channel.exit(signal);
        else channel.exit(code ?? 1);
        channel.end();
      });
    };
    start().catch(() => channel.close());
  }

  function session(client, accept) {
    const channel = accept();
    let forwarded = false;
    channel.on("pty", (_accept, reject) => reject?.());
    channel.on("shell", (_accept, reject) => reject?.());
    channel.on("auth-agent", (acceptAgent, reject) => {
      if (!forwardAgent) return reject?.();
      forwarded = true;
      return acceptAgent?.();
    });
    channel.on("exec", (acceptExec, _reject, info) =>
      run(client, acceptExec, info, forwarded),
    );
  }

  function tunnel(accept, reject, info) {
    if (info.destIP !== "127.0.0.1") return reject();
    const socket = net.connect(info.destPort, "127.0.0.1");
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => reject());
    socket.once("connect", () => {
      const channel = accept();
      socket.removeAllListeners("error");
      socket.on("error", () => channel.destroy());
      channel.on("error", () => socket.destroy());
      socket.pipe(channel).pipe(socket);
    });
  }

  const server = new ssh2.Server({ hostKeys: [hostPair.private] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", authenticate);
    client.on("request", (_accept, reject) => reject?.());
    client.on("ready", () => {
      client.on("session", (accept) => session(client, accept));
      client.on("tcpip", tunnel);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    hostKey: hostPair.public.split(/\s+/).slice(0, 2).join(" "),
    execs,
    logins,
    agentProbes,
    agentMessages,
    async close() {
      for (const child of children) child.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
