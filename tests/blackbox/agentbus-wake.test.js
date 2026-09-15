import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { busFixture, requestBus } from "../helpers/agentbus-broker.js";
import { registerPeer } from "../../vendor/agentbus/agentpier/runtime.js";
import { register } from "../../vendor/agentbus/core/peers.js";

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
    assert.match(await send("Before replacement"), /Empfänger angestoßen/);
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
    assert.match(await pending, /Hinweis beim nächsten Turn/);
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
    assert.match(await send("After fresh proof"), /Empfänger angestoßen/);
    assert.deepEqual(wakes()[1].slice(0, 3), ["queue", "--thread", "native-after"]);
  },
);
