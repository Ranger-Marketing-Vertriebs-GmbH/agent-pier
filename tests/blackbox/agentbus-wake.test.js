import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { busFixture, requestBus } from "../helpers/agentbus-broker.js";
import {
  registerPeer,
  register,
} from "../../server/features/agentbus/agentbus-runtime.js";

// These records are provisioned by the trusted host fixture. The synthetic native
// process never handles CLI arguments; a disposable executable records queue wakes.
function hostRegister(f, session, nativeSessionId) {
  const ctx = f.bus.broker.access.record(session.id);
  const peer = registerPeer(ctx, nativeSessionId, { pid: session.native.pid });
  register(ctx.h, { ...peer, brokerGeneration: ctx.record.generation });
  return peer;
}

test(
  "Codex wake cannot switch native targets while awaiting binding proof",
  { timeout: 10000 },
  async (t) => {
    const f = await busFixture(t);
    const sender = await f.prepare("wake-sender", "opencode");
    const recipient = await f.prepare("wake-recipient", "codex");
    hostRegister(f, sender, "native-sender");
    const target = hostRegister(f, recipient, "native-before");
    const ctx = f.bus.broker.access.record(recipient.id);
    const output = path.join(f.root, "queue-wakes.jsonl");
    const command = path.join(f.root, "record-wake");
    fs.writeFileSync(
      command,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(ctx.h, "launches", `${recipient.id}.json`),
      JSON.stringify({ ...ctx.launch, command }),
    );
    const send = async (text) => {
      const response = await requestBus(sender.launch.env, "tools/call", {
        name: "peer_send",
        arguments: { __agentpierSession: "native-sender", to: target.key, text },
      });
      assert.equal(response.error, undefined);
      assert.notEqual(response.result.isError, true);
      return response.result.content[0].text;
    };
    const wakes = () =>
      fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    f.bus.bindings = {
      async resolve(session, options) {
        assert.equal(session.id, recipient.id);
        assert.equal(options.forInput, true);
        return { id: "native-before", source: "native-process" };
      },
    };
    assert.match(await send("Before replacement"), /dauerhaft gespeichert/);
    await f.bus.broker.drainWakes();
    assert.deepEqual(wakes()[0].slice(0, 3), ["queue", "--thread", "native-before"]);

    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    f.bus.bindings.resolve = async () => {
      enter();
      await gate;
      return { id: "native-before", source: "native-process" };
    };
    const pending = send("During replacement");
    await entered;
    hostRegister(f, recipient, "native-after");
    release();
    assert.match(await pending, /dauerhaft gespeichert/);
    await f.bus.broker.drainWakes();
    assert.equal(
      wakes().length,
      1,
      "An old native proof must not wake the new native identity",
    );
    assert.equal(
      f.bus.queue(ctx.h).summary(target.key).count,
      2,
      "The durable message survives a refused advisory wake",
    );

    f.bus.bindings.resolve = async () => ({
      id: "native-after",
      source: "native-process",
    });
    assert.match(await send("After fresh proof"), /dauerhaft gespeichert/);
    await f.bus.broker.drainWakes();
    assert.deepEqual(wakes()[1].slice(0, 3), ["queue", "--thread", "native-after"]);
  },
);

test("revoking a recipient during deferred proof preserves delivery but prevents wake", async (t) => {
  const f = await busFixture(t);
  const sender = await f.prepare("revoke-wake-sender", "opencode");
  const recipient = await f.prepare("revoke-wake-recipient", "codex");
  hostRegister(f, sender, "native-sender");
  const target = hostRegister(f, recipient, "native-recipient");
  const ctx = f.bus.broker.access.record(recipient.id);
  const output = path.join(f.root, "revoked-wakes");
  const command = path.join(f.root, "record-revoked-wake");
  fs.writeFileSync(
    command,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, 'unexpected');\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(ctx.h, "launches", `${recipient.id}.json`),
    JSON.stringify({ ...ctx.launch, command }),
  );
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.bus.bindings = {
    async resolve() {
      enter();
      await gate;
      return { id: "native-recipient" };
    },
  };
  try {
    const response = await requestBus(sender.launch.env, "tools/call", {
      name: "peer_send",
      arguments: {
        __agentpierSession: "native-sender",
        to: target.key,
        text: "Before revoke",
      },
    });
    assert.notEqual(response.result.isError, true);
    await entered;
    f.bus.broker.revoke(recipient.id);
    release();
    await f.bus.broker.drainWakes();
    assert.equal(fs.existsSync(output), false);
    assert.equal(f.bus.queue(ctx.h).summary(target.key).count, 1);
  } finally {
    release();
  }
});

test("broker close cancels a pending Claude socket connection and prevents late delivery", async (t) => {
  const f = await busFixture(t);
  const sender = await f.prepare("socket-sender", "opencode");
  const recipient = await f.prepare("socket-recipient", "claude");
  hostRegister(f, sender, "native-sender");
  const target = hostRegister(f, recipient, "native-recipient");
  const ctx = f.bus.broker.access.record(recipient.id);
  const directory = ctx.launch.claudeSessionsDir;
  fs.mkdirSync(directory, { recursive: true });
  const socketPath = path.join(f.root, "pending-claude.sock");
  fs.writeFileSync(
    path.join(directory, "fixture.json"),
    JSON.stringify({
      sessionId: "native-recipient",
      pid: recipient.native.pid,
      messagingSocketPath: socketPath,
    }),
  );
  fs.writeFileSync(
    path.join(directory, `${recipient.native.pid}.fixture.key`),
    JSON.stringify({ peerToken: "fixture-secret" }),
  );
  const socket = new EventEmitter();
  socket.destroyed = false;
  let writes = 0,
    enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  socket.write = () => {
    writes++;
  };
  socket.end = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
    queueMicrotask(() => socket.emit("close"));
  };
  const connect = net.createConnection;
  t.mock.method(net, "createConnection", (address, ...args) => {
    if (address !== socketPath) return connect(address, ...args);
    enter();
    return socket;
  });
  const credential = JSON.parse(
    fs.readFileSync(sender.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE),
  );
  assert.match(
    await f.bus.broker.call(credential, "peer_send", {
      __agentpierSession: "native-sender",
      to: target.key,
      text: "Persist before connect",
    }),
    /dauerhaft gespeichert/,
  );
  await entered;
  let timer;
  try {
    const closing = f.bus.broker.close();
    assert.equal(
      await Promise.race([
        closing.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]),
      true,
      "Shutdown cannot wait for the socket connect event",
    );
    assert.equal(socket.destroyed, true);
    socket.emit("connect");
    assert.equal(writes, 0);
    assert.equal(f.bus.queue(ctx.h).summary(target.key).count, 1);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
});
