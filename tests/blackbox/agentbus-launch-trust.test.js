import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { busFixture, provisionLaunch, requestBus } from "../helpers/agentbus-broker.js";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import {
  registerPeer,
  register,
} from "../../server/features/agentbus/agentbus-runtime.js";

// The launch record under projects/<id>/launches lies in the folder a sandboxed
// session may write. These tests change it the way such a session could and check
// that the server keeps using what it recorded for itself.
function hostRegister(f, session, nativeSessionId) {
  const ctx = f.bus.broker.access.record(session.id);
  const peer = registerPeer(ctx, nativeSessionId, { pid: session.native.pid });
  register(ctx.h, { ...peer, brokerGeneration: ctx.record.generation });
  return peer;
}
const recordFile = (f, id) =>
  path.join(f.bus.broker.access.record(id).h, "launches", `${id}.json`);
function rewrite(f, id, changes) {
  const file = recordFile(f, id);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...written, ...changes }));
}
function recorder(f, name) {
  const output = path.join(f.root, `${name}.jsonl`);
  const command = path.join(f.root, name);
  fs.writeFileSync(
    command,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }) + '\\n');\n`,
    { mode: 0o700 },
  );
  const calls = () =>
    fs.existsSync(output)
      ? fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse)
      : [];
  return { command, calls };
}
async function codexPair(t) {
  const f = await busFixture(t);
  const sender = await f.prepare("trust-sender", "opencode");
  const recipient = await f.prepare("trust-recipient", "codex");
  hostRegister(f, sender, "native-sender");
  const target = hostRegister(f, recipient, "native-recipient");
  f.bus.bindings = {
    resolve: async () => ({ id: "native-recipient", source: "native-process" }),
  };
  const send = async (bus = f.bus) => {
    const response = await requestBus(sender.launch.env, "tools/call", {
      name: "peer_send",
      arguments: { __agentpierSession: "native-sender", to: target.key, text: "Hello" },
    });
    assert.equal(response.error, undefined);
    assert.notEqual(response.result.isError, true);
    await bus.broker.drainWakes();
  };
  return { f, sender, recipient, target, send };
}

test("a rewritten launch record does not change what a Codex wake runs", async (t) => {
  const { f, recipient, send } = await codexPair(t);
  const trusted = recorder(f, "trusted-codex");
  const planted = recorder(f, "planted-codex");
  provisionLaunch(f, recipient.id, { command: trusted.command });
  const codexHome = f.bus.broker.access.record(recipient.id).launch.codexHome;
  rewrite(f, recipient.id, {
    command: planted.command,
    codexHome: path.join(f.root, "planted-home"),
  });
  await send();
  assert.deepEqual(planted.calls(), []);
  assert.equal(trusted.calls().length, 1);
  assert.deepEqual(trusted.calls()[0].args.slice(0, 3), [
    "queue",
    "--thread",
    "native-recipient",
  ]);
  assert.equal(trusted.calls()[0].home, codexHome);
  // The process proof uses the server's copy as well.
  const { launch } = f.bus.broker.access.record(recipient.id);
  assert.equal(launch.command, trusted.command);
  assert.equal(launch.codexHome, codexHome);
});

test("the server's copy of a launch survives a restart", async (t) => {
  const { f, recipient } = await codexPair(t);
  const before = f.bus.broker.access.record(recipient.id).launch;
  rewrite(f, recipient.id, { command: "/planted/codex", claudeSessionsDir: "/planted" });
  await f.bus.close();
  const bus = new AgentBus({
    dataDir: f.dataDir,
    home: f.home,
    accounts: f.accounts,
    sessions: f.sessions,
  });
  t.after(() => bus.close());
  await bus.ready;
  assert.deepEqual(bus.broker.access.record(recipient.id).launch, before);
});

test("a session launched before the server kept a copy is taken over once", async (t) => {
  const { f, recipient } = await codexPair(t);
  const active = path.join(f.bus.root, "sessions", recipient.id, "active.json");
  const old = JSON.parse(fs.readFileSync(active, "utf8"));
  delete old.launch;
  fs.writeFileSync(active, JSON.stringify(old));
  const written = JSON.parse(fs.readFileSync(recordFile(f, recipient.id), "utf8"));
  const first = f.bus.broker.access.record(recipient.id);
  assert.equal(first.launch.command, written.command);
  assert.equal(first.launch.codexHome, written.codexHome);
  assert.equal(first.launch.claudeSessionsDir, written.claudeSessionsDir);
  assert.equal(first.record.generation, old.generation);
  assert.equal(fs.statSync(active).mode & 0o777, 0o600);
  rewrite(f, recipient.id, { command: "/planted/codex" });
  assert.equal(f.bus.broker.access.record(recipient.id).launch.command, written.command);
});

test("a launch record that names another folder ends the session's access", async (t) => {
  const { f, recipient } = await codexPair(t);
  rewrite(f, recipient.id, { cwd: f.home });
  assert.throws(() => f.bus.broker.access.record(recipient.id), /unavailable/);
});

test("a Claude wake reads the socket and key only from the folder the server recorded", async (t) => {
  const f = await busFixture(t);
  const sender = await f.prepare("claude-trust-sender", "opencode");
  const recipient = await f.prepare("claude-trust-recipient", "claude");
  hostRegister(f, sender, "native-sender");
  const target = hostRegister(f, recipient, "native-recipient");
  const planted = path.join(f.root, "planted-sessions");
  const socketDir = fs.mkdtempSync("/tmp/ap-trust-");
  t.after(() => fs.rmSync(socketDir, { recursive: true, force: true }));
  const socketPath = path.join(socketDir, "s.sock");
  let received = "";
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      received += chunk;
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // A registry entry and key of the session's own making, in a folder it chose.
  fs.mkdirSync(planted);
  fs.writeFileSync(
    path.join(planted, "entry.json"),
    JSON.stringify({
      sessionId: "native-recipient",
      pid: recipient.native.pid,
      messagingSocketPath: socketPath,
    }),
  );
  const key = path.join(planted, `${recipient.native.pid}.planted.key`);
  fs.writeFileSync(key, JSON.stringify({ peerToken: "planted-token" }));
  rewrite(f, recipient.id, { claudeSessionsDir: planted });
  const response = await requestBus(sender.launch.env, "tools/call", {
    name: "peer_send",
    arguments: { __agentpierSession: "native-sender", to: target.key, text: "Hello" },
  });
  assert.notEqual(response.result.isError, true);
  await f.bus.broker.drainWakes();
  assert.equal(received, "");
});
