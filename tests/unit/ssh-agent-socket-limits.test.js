import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentHosts } from "../../server/features/ssh/ssh-agent-policy.js";
import { agentMessage } from "../../server/features/ssh/ssh-agent-protocol.js";
import { SessionAgentSocket } from "../../server/features/ssh/ssh-agent-socket.js";
import {
  AgentClient,
  generateKey,
  sshAdd,
  userauth,
  verifyWithPublic,
} from "../helpers/ssh-agent-client.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-agent-limits-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const userKey = generateKey(root, "user");
const hostKey = generateKey(root, "host");
const hosts = agentHosts(
  [
    {
      id: "access-a",
      name: "Proxmox 2",
      host: "10.0.0.2",
      port: 22,
      username: "deploy",
      keyId: "0123abcd-1111-2222-3333-444444444444",
      publicKey: userKey.publicLine,
      hostKey: hostKey.publicLine,
      type: "ssh",
      createdAt: "2026-10-29T00:00:00.000Z",
    },
  ],
  ["access-a"],
);

let counter = 0;
function socketPath() {
  counter += 1;
  return path.join(root, `s${counter}`, "agent.sock");
}

function agentAt(file, options = {}) {
  const signed = [];
  const agent = new SessionAgentSocket({
    socketPath: file,
    authorize: async () => ({ hosts }),
    readIdentity: () => userKey.privateText,
    onSigned: (host) => signed.push(host),
    onDenied: () => {},
    ...options,
  });
  agent.signed = signed;
  return agent;
}

async function listening(t, options) {
  const file = socketPath();
  const agent = agentAt(file, options);
  await agent.listen();
  t.after(() => agent.close());
  return { agent, file };
}

function closed(socket) {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", resolve);
  });
}

// A socket file nobody listens on: a child process bound it and was killed.
async function staleSocket(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("up"))`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.equal(fs.lstatSync(file).isSocket(), true);
}

test("an oversized frame closes only that connection", async (t) => {
  const { file } = await listening(t);
  const good = await AgentClient.connect(file);
  t.after(() => good.close());
  const bad = net.createConnection(file);
  bad.on("error", () => {});
  await new Promise((resolve) => bad.once("connect", resolve));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(262145);
  bad.write(header);
  await closed(bad);
  assert.equal((await good.identities()).length, 1);
});

test("a frame at the size limit is read; the buffer never grows past it", async (t) => {
  const { file } = await listening(t, { maxMessage: 1024 });
  const client = await AgentClient.connect(file);
  t.after(() => client.close());
  assert.equal(await client.raw(99, Buffer.alloc(1023)), agentMessage.FAILURE);
  const bad = net.createConnection(file);
  bad.on("error", () => {});
  await new Promise((resolve) => bad.once("connect", resolve));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(1025);
  bad.write(Buffer.concat([header, Buffer.alloc(512)]));
  await closed(bad);
});

test("pipelined requests are answered in order", async (t) => {
  const { file } = await listening(t);
  const client = await AgentClient.connect(file);
  t.after(() => client.close());
  const answers = await Promise.all([
    client.identities(),
    client.raw(17),
    client.identities(),
    client.raw(25),
  ]);
  assert.deepEqual(
    answers.map((answer) => (Array.isArray(answer) ? answer.length : answer)),
    [1, agentMessage.FAILURE, 1, agentMessage.FAILURE],
  );
});

test("concurrent connections keep their own binding", async (t) => {
  const { file, agent } = await listening(t);
  const clients = await Promise.all(
    Array.from({ length: 12 }, () => AgentClient.connect(file)),
  );
  t.after(() => Promise.all(clients.map((client) => client.close())));
  const sids = clients.map(() => randomBytes(32));
  await Promise.all(
    clients.map((client, i) => client.bind({ hostKey, sessionId: sids[i] })),
  );
  const results = await Promise.all(
    clients.map(async (client, i) => {
      const own = userauth({ sessionId: sids[i], keyBlob: userKey.blob });
      const foreign = userauth({ sessionId: sids[(i + 1) % 12], keyBlob: userKey.blob });
      const [blob, refused] = await Promise.all([
        client.sign(userKey.blob, own, 4),
        client.signRaw(userKey.blob, foreign, 4),
      ]);
      return verifyWithPublic(userKey.publicLine, own, blob) && refused === 5;
    }),
  );
  assert.deepEqual(results, Array(12).fill(true));
  assert.equal(agent.signed.length, 12);
});

test("connections beyond maxConnections are closed", async (t) => {
  const { file } = await listening(t, { maxConnections: 2 });
  const first = await AgentClient.connect(file);
  const second = await AgentClient.connect(file);
  t.after(() => Promise.all([first.close(), second.close()]));
  const third = net.createConnection(file);
  third.on("error", () => {});
  await closed(third);
  assert.equal((await first.identities()).length, 1);
  await first.close();
  // A freed slot is usable again.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fourth = await AgentClient.connect(file);
  t.after(() => fourth.close());
  assert.equal((await fourth.identities()).length, 1);
});

test("an idle connection is closed", async (t) => {
  const { file } = await listening(t, { idleMs: 100 });
  const client = await AgentClient.connect(file);
  const started = Date.now();
  await client.closed;
  assert.ok(Date.now() - started >= 90);
});

test("a stale socket is replaced; a live one is not", async (t) => {
  const file = socketPath();
  await staleSocket(file);
  const agent = agentAt(file);
  await agent.listen();
  t.after(() => agent.close());
  assert.equal((await sshAdd(file, ["-L"])).code, 0);
  const second = agentAt(file);
  await assert.rejects(second.listen(), { code: "SSH_AGENT_SOCKET_BUSY" });
  // The live agent still answers on its socket.
  assert.equal((await sshAdd(file, ["-L"])).code, 0);
});

test("a file that is not a socket is never removed", async () => {
  const file = socketPath();
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  fs.writeFileSync(file, "keep");
  await assert.rejects(agentAt(file).listen(), { code: "SSH_AGENT_SOCKET_UNSAFE" });
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
  const link = socketPath();
  fs.mkdirSync(path.dirname(link), { mode: 0o700 });
  fs.symlinkSync(file, link);
  await assert.rejects(agentAt(link).listen(), { code: "SSH_AGENT_SOCKET_UNSAFE" });
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
});

test("close ends open connections and removes the socket", async () => {
  const file = socketPath();
  const agent = agentAt(file);
  await agent.listen();
  const client = await AgentClient.connect(file);
  await agent.close();
  await client.closed;
  assert.equal(fs.existsSync(file), false);
  // The folder stays for a restart at the same path.
  assert.equal(fs.statSync(path.dirname(file)).isDirectory(), true);
  await agent.close();
  await agent.listen().then(
    () => assert.fail("a closed agent does not listen again"),
    (error) => assert.equal(error.code, "SSH_AGENT_CLOSED"),
  );
});

// Many granted keys make every identities answer about 2 KiB, so a client that does
// not read fills the socket buffers quickly.
const manyHosts = agentHosts(
  Array.from({ length: 24 }, (_, i) => ({
    id: `access-${i}`,
    name: `Host ${i}`,
    host: "10.0.0.2",
    port: 22,
    username: "deploy",
    keyId: `${String(i).padStart(8, "0")}-1111-2222-3333-444444444444`,
    publicKey: generateKey(root, `many-${i}`).publicLine,
    hostKey: hostKey.publicLine,
    type: "ssh",
  })),
  Array.from({ length: 24 }, (_, i) => `access-${i}`),
);

function serverSide(agent) {
  return [...agent.connections].at(-1);
}

test("a client that does not read never grows the server's listeners", async (t) => {
  const { agent, file } = await listening(t, {
    authorize: async () => ({ hosts: manyHosts }),
  });
  const socket = net.createConnection(file);
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.pause();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const server = serverSide(agent);
  const baseline = server.listenerCount("close");
  const frames = 250;
  const counts = [];
  const sample = setInterval(() => counts.push(server.listenerCount("close")), 2);
  socket.write(Buffer.concat(Array(frames).fill(Buffer.from([0, 0, 0, 1, 11]))));
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Backpressure holds the answers: not all of them fit into the buffers.
  assert.ok(server.writableLength > 0 || server.isPaused());
  let received = 0;
  const all = new Promise((resolve) =>
    socket.on("data", (chunk) => {
      received += chunk.length;
      if (received >= frames * 1800) resolve();
    }),
  );
  socket.resume();
  await all;
  await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(sample);
  assert.ok(
    Math.max(...counts) <= baseline + 1,
    `close listeners: ${Math.max(...counts)}`,
  );
  assert.equal(server.listenerCount("close"), baseline);
  assert.equal(server.listenerCount("drain"), 0);
  socket.destroy();
});

test("a client that queues more requests than allowed is closed", async (t) => {
  const { file } = await listening(t, { maxQueued: 8 });
  const good = await AgentClient.connect(file);
  t.after(() => good.close());
  const socket = net.createConnection(file);
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.pause();
  socket.write(Buffer.concat(Array(20).fill(Buffer.from([0, 0, 0, 1, 11]))));
  await closed(socket);
  assert.equal((await good.identities()).length, 1);
});

test("an answer that throws is a FAILURE and the connection goes on", async (t) => {
  const { agent, file } = await listening(t);
  const original = agent.answer.bind(agent);
  let thrown = false;
  agent.answer = async (state, frame) => {
    if (!thrown) {
      thrown = true;
      throw new Error("unexpected");
    }
    return original(state, frame);
  };
  const client = await AgentClient.connect(file);
  t.after(() => client.close());
  assert.equal(await client.identities(), agentMessage.FAILURE);
  assert.equal((await client.identities()).length, 1);
});
