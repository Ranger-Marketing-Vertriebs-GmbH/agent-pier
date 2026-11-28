import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentAlive, internalPorts } from "../../server/application/preview-wiring.js";
import {
  adapterPortPath,
  recordAdapterPort,
} from "../../server/features/adapter-runtime/adapter-diagnostics.js";

function sessionsDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-preview-wiring-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("internal ports name AgentPier, the bridge, the reminder webhook, the Gateway band and running adapters", (t) => {
  const directory = sessionsDirectory(t);
  for (const [id, status, port] of [
    ["run", "running", 41001],
    ["old", "stopped", 41002],
  ]) {
    fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ status }));
    recordAdapterPort(path.join(directory, `${id}.adapter.json`), port);
  }
  assert.ok(fs.existsSync(adapterPortPath(path.join(directory, "run.adapter.json"))));
  const ports = internalPorts({
    effectiveConfig: () => ({ port: 4999 }),
    assistantTeams: { bridge: { connection: { url: "http://127.0.0.1:41100" } } },
    assistantReminders: { webhook: { connection: { url: "http://127.0.0.1:41200" } } },
    assistantRuntime: {
      client: { url: "wss://127.0.0.1:42000" },
      webTools: { browserProfiles: { a: { cdpPort: 43000 } } },
    },
    assistants: {
      browsers: { running: new Map([["b", { keeper: { cdpPort: 43001 } }]]) },
    },
    sessions: { directory },
  });
  // 42111: the embedding server's port, right after the Gateway's CDP ports.
  for (const port of [
    4999, 41100, 41200, 42000, 42011, 42110, 42111, 43000, 43001, 41001,
  ])
    assert.ok(ports.has(port), `${port} is internal`);
  assert.equal(ports.has(41002), false);
  assert.equal(ports.has(42112), false);
});

test("the private adb server and the ports of running devices are internal", () => {
  // Without the device service the adb server's fixed port is still never a target.
  assert.ok(internalPorts({}).has(47600));
  const running = [47602, 47603];
  const ports = internalPorts({
    devices: { sources: { emulator: { adbPort: 47600 } }, ports: () => running },
  });
  for (const port of [47600, 47602, 47603]) assert.ok(ports.has(port), `${port}`);
  assert.equal(ports.has(47604), false);
  // A stopped device holds no port.
  running.length = 0;
  assert.deepEqual(
    [...internalPorts({ devices: { sources: {}, ports: () => running } })],
    [47600],
  );
});

test("an agent preview lives while its conversation and unarchived agent exist", () => {
  const conversations = { c1: { assistantId: "a1" } };
  const agents = { a1: { archivedAt: null }, a2: { archivedAt: "2026-11-01" } };
  const missing = () => {
    throw new Error("not found");
  };
  const services = {
    assistants: {
      store: {
        getConversation: (id) => conversations[id] || missing(),
        getAssistant: (id) => agents[id] || missing(),
      },
    },
  };
  assert.equal(agentAlive(services, { assistantId: "a1", conversationId: "c1" }), true);
  assert.equal(agentAlive(services, { assistantId: "a2", conversationId: "c1" }), false);
  assert.equal(
    agentAlive(services, { assistantId: "a1", conversationId: "gone" }),
    false,
  );
  conversations.c2 = { assistantId: "a2" };
  assert.equal(agentAlive(services, { assistantId: "a2", conversationId: "c2" }), false);
  assert.equal(agentAlive({}, { assistantId: "a1", conversationId: "c1" }), false);
});
