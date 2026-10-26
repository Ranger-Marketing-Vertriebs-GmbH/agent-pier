import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { busFixture } from "../helpers/agentbus-broker.js";
import {
  registerPeer,
  register,
} from "../../server/features/agentbus/agentbus-runtime.js";

// Claude Code holds a cross-session message whose attested permission class
// (from-mode) differs from its own, so an idle bypass session is never woken by a
// sender that AgentPier misreports as "prompting".
function hostRegister(f, session, nativeSessionId) {
  const ctx = f.bus.broker.access.record(session.id);
  const peer = registerPeer(ctx, nativeSessionId, { pid: session.native.pid });
  register(ctx.h, { ...peer, brokerGeneration: ctx.record.generation });
  return peer;
}

async function claudeWake(t, senderTool, senderSession) {
  const f = await busFixture(t);
  const sender = await f.prepare("mode-sender", senderTool);
  const recipient = await f.prepare("mode-recipient", "claude");
  Object.assign(f.rows.get(sender.id), senderSession);
  hostRegister(f, sender, "native-sender");
  const target = hostRegister(f, recipient, "native-recipient");
  const ctx = f.bus.broker.access.record(recipient.id);
  const directory = ctx.launch.claudeSessionsDir;
  fs.mkdirSync(directory, { recursive: true });
  const socketPath = path.join(f.root, "claude-wake.sock");
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
  let payload = "";
  const connect = net.createConnection;
  t.mock.method(net, "createConnection", (address, ...args) => {
    if (address !== socketPath) return connect(address, ...args);
    const socket = new EventEmitter();
    socket.write = (chunk) => {
      payload += chunk;
    };
    socket.end = () => queueMicrotask(() => socket.emit("close"));
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  const credential = JSON.parse(
    fs.readFileSync(sender.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE),
  );
  assert.match(
    await f.bus.broker.call(credential, "peer_send", {
      __agentpierSession: "native-sender",
      to: target.key,
      text: "Reply for an idle Claude session",
    }),
    /dauerhaft gespeichert/,
  );
  await f.bus.broker.drainWakes();
  const lines = payload.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2, "The wake reaches the Claude messaging socket");
  return lines[1].message.content;
}

const cases = [
  ["codex", { launchMode: "yolo" }, "bypass"],
  ["codex", { launchMode: "default" }, "prompting"],
  ["claude", { launchMode: "bypass" }, "bypass"],
  ["claude", { launchMode: "auto" }, "prompting"],
  [
    "claude",
    { launchMode: "default", permissionArgs: ["--permission-mode", "bypassPermissions"] },
    "bypass",
  ],
  ["opencode", { launchMode: "auto" }, "bypass"],
  ["opencode", {}, "prompting"],
  ["claude", { launchMode: "default", pipeline: { headless: true } }, "bypass"],
];
for (const [tool, session, mode] of cases)
  test(`Claude wake attests a ${tool} ${JSON.stringify(session)} sender as ${mode}`, async (t) => {
    const content = await claudeWake(t, tool, session);
    assert.match(content, new RegExp(` from-mode="${mode}">\\n`));
  });
