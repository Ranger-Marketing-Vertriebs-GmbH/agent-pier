import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentHosts } from "../../server/features/ssh/ssh-agent-policy.js";
import { agentMessage } from "../../server/features/ssh/ssh-agent-protocol.js";
import {
  agentSocketPath,
  newAgentToken,
  SessionAgentSocket,
} from "../../server/features/ssh/ssh-agent-socket.js";
import {
  AgentClient,
  generateKey,
  hostSignature,
  sshAdd,
  userauth,
  verifyWithPublic,
} from "../helpers/ssh-agent-client.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-agent-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const dataDir = path.join(root, "data");

const userKey = generateKey(root, "user");
const hostKey = generateKey(root, "host");
const otherHostKey = generateKey(root, "other-host");
const keyId = "0123abcd-1111-2222-3333-444444444444";

const accessA = {
  id: "access-a",
  name: "Proxmox 2",
  host: "10.0.0.2",
  port: 22,
  username: "deploy",
  keyId,
  publicKey: userKey.publicLine,
  hostKey: hostKey.publicLine,
  type: "ssh",
  legacyAlgorithms: false,
  interactiveShell: false,
  createdAt: "2026-10-29T00:00:00.000Z",
};

let counter = 0;
// One agent per test with its own folder, recorded callbacks and switchable grants.
async function start(t, options = {}) {
  counter += 1;
  const socketPath = path.join(root, `s${counter}`, "agent.sock");
  const state = {
    grants: { hosts: agentHosts([accessA], ["access-a"]) },
    identity: () => userKey.privateText,
    signed: [],
    denied: [],
    authorizeCalls: 0,
  };
  const agent = new SessionAgentSocket({
    socketPath,
    authorize: async () => {
      state.authorizeCalls += 1;
      return typeof state.grants === "function" ? state.grants() : state.grants;
    },
    readIdentity: (id) => state.identity(id),
    onSigned: (host) => state.signed.push(host),
    onDenied: (code) => state.denied.push(code),
    ...options,
  });
  await agent.listen();
  const clients = [];
  state.client = async () => {
    const client = await AgentClient.connect(socketPath);
    clients.push(client);
    return client;
  };
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await agent.close();
  });
  return { agent, socketPath, state };
}

const sessionId = () => randomBytes(32);

test("socket path fits sun_path and is per agent token", () => {
  const sid = randomUUID();
  const a = agentSocketPath(dataDir, sid, newAgentToken());
  assert.ok(Buffer.byteLength(a) < 100);
  assert.match(
    a,
    /^\/tmp\/agentpier-sshagent-[^/]+-[0-9a-f]{20}\/[0-9a-f]{32}\/agent\.sock$/,
  );
  assert.notEqual(a, agentSocketPath(dataDir, sid, newAgentToken()));
  assert.equal(
    path.dirname(path.dirname(a)),
    path.dirname(path.dirname(agentSocketPath(dataDir, randomUUID(), newAgentToken()))),
  );
  // The path never contains the session id, so another session cannot derive it.
  assert.equal(a.includes(sid), false);
  // Pure: nothing is created.
  assert.equal(fs.existsSync(path.dirname(a)), false);
});

test("socket path refuses malformed session ids and tokens", () => {
  const token = newAgentToken();
  assert.match(token, /^[0-9a-f]{32}$/);
  for (const sid of ["../x", "", "a/b", "x".repeat(121), null])
    assert.throws(() => agentSocketPath(dataDir, sid, token), {
      code: "SSH_AGENT_SESSION_INVALID",
    });
  for (const bad of ["../x", "", "A".repeat(32), "ab".repeat(15), undefined])
    assert.throws(() => agentSocketPath(dataDir, "session-1", bad), {
      code: "SSH_AGENT_TOKEN_INVALID",
    });
});

test("socket and its folders are owner-only", async (t) => {
  const { socketPath } = await start(t);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(path.dirname(socketPath))).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600);
});

test("a symlinked socket folder is refused", async () => {
  const target = fs.mkdtempSync(path.join(root, "target-"));
  const parent = path.join(root, "linked");
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.symlinkSync(target, path.join(parent, "sock"));
  const agent = new SessionAgentSocket({
    socketPath: path.join(parent, "sock", "agent.sock"),
    authorize: async () => null,
    readIdentity: () => "",
    onSigned: () => {},
    onDenied: () => {},
  });
  await assert.rejects(agent.listen(), { code: "SSH_AGENT_SOCKET_UNSAFE" });
  assert.deepEqual(fs.readdirSync(target), []);
});

test("identities list only granted keys; revoked authorization lists none", async (t) => {
  const { state } = await start(t);
  const client = await state.client();
  const list = await client.identities();
  assert.equal(list.length, 1);
  assert.ok(list[0].keyBlob.equals(userKey.blob));
  assert.equal(list[0].comment, "agentpier-0123abcd");
  state.grants = null;
  assert.deepEqual(await client.identities(), []);
  assert.equal(state.authorizeCalls, 2);
  assert.deepEqual(state.denied, []);
});

test("the real ssh-add lists the granted key and its test signature is refused", async (t) => {
  const { socketPath, state } = await start(t);
  const listed = await sshAdd(socketPath, ["-L"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.stdout.trim(), `${userKey.publicLine} agentpier-0123abcd`);
  // ssh-add -T signs random data without a session-bind: never a signature.
  const tested = await sshAdd(socketPath, ["-T", `${userKey.file}.pub`]);
  assert.notEqual(tested.code, 0);
  assert.deepEqual(state.denied, ["SSH_AGENT_UNBOUND"]);
  assert.deepEqual(state.signed, []);
  // Add, remove and lock through the real client fail too.
  assert.notEqual((await sshAdd(socketPath, ["-D"])).code, 0);
  assert.equal((await sshAdd(socketPath, ["-L"])).code, 0);
});

test("a bound userauth request is signed and reported", async (t) => {
  const { state } = await start(t);
  const client = await state.client();
  const sid = sessionId();
  assert.equal(await client.bind({ hostKey, sessionId: sid }), agentMessage.SUCCESS);
  const data = userauth({ sessionId: sid, keyBlob: userKey.blob });
  const blob = await client.sign(userKey.blob, data, 4);
  assert.equal(verifyWithPublic(userKey.publicLine, data, blob), true);
  assert.deepEqual(
    state.signed.map((h) => h.accessId),
    ["access-a"],
  );
  assert.deepEqual(state.denied, []);
});

test("unbound, forwarded and ungranted requests fail with their codes", async (t) => {
  const { state } = await start(t);
  const client = await state.client();
  const sid = sessionId();
  const data = userauth({ sessionId: sid, keyBlob: userKey.blob });
  const reply = await client.signReply(userKey.blob, data);
  // Bare FAILURE on the wire: the code goes to onDenied only.
  assert.deepEqual([...reply], [agentMessage.FAILURE]);
  await client.bind({ hostKey, sessionId: sid, forwarding: true });
  assert.equal(await client.signRaw(userKey.blob, data), agentMessage.FAILURE);
  const fresh = await state.client();
  await fresh.bind({ hostKey: otherHostKey, sessionId: sid });
  assert.equal(await fresh.signRaw(userKey.blob, data), agentMessage.FAILURE);
  assert.deepEqual(state.denied, [
    "SSH_AGENT_UNBOUND",
    "SSH_AGENT_FORWARDING",
    "SSH_AGENT_NOT_GRANTED",
  ]);
  assert.deepEqual(state.signed, []);
});

test("forwarding stays for the connection's life after a later normal bind", async (t) => {
  const { state } = await start(t);
  const client = await state.client();
  const sid = sessionId();
  assert.equal(
    await client.bind({ hostKey, sessionId: sid, forwarding: true }),
    agentMessage.SUCCESS,
  );
  assert.equal(await client.bind({ hostKey, sessionId: sid }), agentMessage.SUCCESS);
  const data = userauth({ sessionId: sid, keyBlob: userKey.blob });
  assert.equal(await client.signRaw(userKey.blob, data, 4), agentMessage.FAILURE);
  assert.deepEqual(state.denied, ["SSH_AGENT_FORWARDING"]);
  // A forged forwarding bind marks the connection as well.
  const other = await state.client();
  const forged = hostSignature(otherHostKey, sid);
  await other.bindRaw({
    hostKeyBlob: hostKey.blob,
    sessionId: sid,
    signature: forged,
    forwarding: true,
  });
  await other.bind({ hostKey, sessionId: sid });
  assert.equal(await other.signRaw(userKey.blob, data, 4), agentMessage.FAILURE);
  assert.deepEqual(state.denied, ["SSH_AGENT_FORWARDING", "SSH_AGENT_FORWARDING"]);
});

test("a bind with a forged host signature is refused and binds nothing", async (t) => {
  const { state } = await start(t);
  const client = await state.client();
  const sid = sessionId();
  const forged = hostSignature(otherHostKey, sid);
  assert.equal(
    await client.bindRaw({
      hostKeyBlob: hostKey.blob,
      sessionId: sid,
      signature: forged,
    }),
    agentMessage.FAILURE,
  );
  const data = userauth({ sessionId: sid, keyBlob: userKey.blob });
  assert.equal(await client.signRaw(userKey.blob, data, 4), agentMessage.FAILURE);
  assert.deepEqual(state.denied, ["SSH_AGENT_UNBOUND"]);
});

test("a failed bind keeps the earlier verified binding", async (t) => {
  const { state } = await start(t);
  const client = await state.client();
  const sid = sessionId();
  await client.bind({ hostKey, sessionId: sid });
  // Another host key with a signature that host never made.
  const forged = hostSignature(hostKey, sid);
  assert.equal(
    await client.bindRaw({
      hostKeyBlob: otherHostKey.blob,
      sessionId: sid,
      signature: forged,
    }),
    agentMessage.FAILURE,
  );
  const data = userauth({ sessionId: sid, keyBlob: userKey.blob });
  assert.ok(await client.sign(userKey.blob, data, 4));
});

test("add, remove, lock and unknown extension requests fail", async (t) => {
  const { state } = await start(t);
  const client = await state.client();
  for (const type of [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 99])
    assert.equal(await client.raw(type), agentMessage.FAILURE);
  const query = Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from("query")]);
  assert.equal(await client.raw(27, query), agentMessage.FAILURE);
  // Malformed requests fail without closing the connection.
  assert.equal(await client.raw(13, Buffer.from([0, 0, 0, 9])), agentMessage.FAILURE);
  assert.equal((await client.identities()).length, 1);
  assert.deepEqual(state.denied, []);
});

test("throws while authorizing, reading or signing fail with a code", async (t) => {
  const { state } = await start(t);
  const client = await state.client();
  const sid = sessionId();
  await client.bind({ hostKey, sessionId: sid });
  const data = userauth({ sessionId: sid, keyBlob: userKey.blob });
  state.grants = () => {
    throw new Error("store unreadable");
  };
  assert.equal(await client.signRaw(userKey.blob, data, 4), agentMessage.FAILURE);
  assert.equal(await client.identities(), agentMessage.FAILURE);
  state.grants = { hosts: agentHosts([accessA], ["access-a"]) };
  state.identity = () => {
    throw Object.assign(new Error("ENOENT: /secret/identity"), { code: "ENOENT" });
  };
  assert.equal(await client.signRaw(userKey.blob, data, 4), agentMessage.FAILURE);
  state.identity = () => "-----BEGIN OPENSSH PRIVATE KEY-----\nbroken\n";
  assert.equal(await client.signRaw(userKey.blob, data, 4), agentMessage.FAILURE);
  // A private key that is not the listed public key cannot sign for it.
  state.identity = () => otherHostKey.privateText;
  assert.equal(await client.signRaw(userKey.blob, data, 4), agentMessage.FAILURE);
  assert.deepEqual(state.denied, [
    "SSH_AGENT_NOT_GRANTED",
    "SSH_AGENT_NOT_GRANTED",
    "SSH_AGENT_KEY_UNSUPPORTED",
    "SSH_AGENT_KEY_UNSUPPORTED",
    "SSH_AGENT_KEY_UNSUPPORTED",
  ]);
  assert.deepEqual(state.signed, []);
  // The connection still serves.
  state.identity = () => userKey.privateText;
  assert.ok(await client.sign(userKey.blob, data, 4));
});

test("a throwing callback never breaks an answer", async (t) => {
  const { state } = await start(t, {
    onSigned: () => {
      throw new Error("audit down");
    },
    onDenied: () => {
      throw new Error("audit down");
    },
  });
  const client = await state.client();
  const sid = sessionId();
  const data = userauth({ sessionId: sid, keyBlob: userKey.blob });
  assert.equal(await client.signRaw(userKey.blob, data, 4), agentMessage.FAILURE);
  await client.bind({ hostKey, sessionId: sid });
  assert.ok(await client.sign(userKey.blob, data, 4));
});
