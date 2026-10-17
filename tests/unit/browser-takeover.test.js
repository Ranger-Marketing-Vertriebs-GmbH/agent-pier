import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { BrowserLiveView } from "../../server/features/assistants/browser-live-view.js";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { browserProfileMap } from "../../server/features/assistants/openclaw-config/browser-profiles.js";
import { noteBrowserHandBack } from "../../server/features/assistants/browser-hand-back.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const settle = async () => {
  for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 2));
};
const frame = (cssWidth, cssHeight) => {
  const header = Buffer.from(JSON.stringify({ cssWidth, cssHeight }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, Buffer.from([0xff, 0xd8])]);
};

function fixture() {
  let clock = 0;
  const gateway = {
    tabs: [{ targetId: "CDP-1", url: "https://a/" }],
    sockets: [],
    tickets: [],
  };
  const client = {
    ready: true,
    request: async (_m, { path, body }) => {
      if (path === "/") return { running: true };
      if (path === "/tabs") return { tabs: gateway.tabs };
      gateway.tickets.push(body);
      return { wsPath: "/w", targetId: body.targetId || gateway.tabs.at(-1).targetId };
    },
    openStream: () => {
      const ws = Object.assign(new EventEmitter(), { close() {} });
      gateway.sockets.push(ws);
      return ws;
    },
  };
  const dispatched = [];
  const handBacks = [];
  const live = new BrowserLiveView({
    browsers: {
      viewProfile: () => ({ name: "agent-a", entry: { cdpPort: 4321, headless: false } }),
      viewReason: () => "noProfile",
      watched() {},
    },
    runtime: { client },
    pollMs: 60_000,
    now: () => clock,
    cdpInput: (port) => ({
      cdpPort: port,
      dispatch: async (targetId, calls) => dispatched.push({ port, targetId, calls }),
      close() {},
    }),
    onHandBack: (id, reason) => handBacks.push([id, reason]),
  });
  const viewer = () => {
    const seen = { states: [] };
    seen.viewer = { state: (s) => seen.states.push(s), frame() {}, end() {} };
    return seen;
  };
  return { live, gateway, viewer, dispatched, handBacks, tick: (ms) => (clock += ms) };
}

test("the holder's input reaches the shown tab, mapped to the page", async () => {
  const f = fixture();
  const owner = f.viewer();
  const view = f.live.subscribe("a", owner.viewer, { holder: "phone" });
  await settle();
  f.gateway.sockets[0].emit("message", frame(1000, 500), true);
  // Input before taking over, or from a preview, is refused.
  await assert.rejects(view.input({ type: "text", text: "x" }), { code: "NOT_HOLDER" });
  const preview = f.live.subscribe("a", f.viewer().viewer, {
    preview: true,
    holder: "phone",
  });
  assert.throws(() => preview.take(), { code: "VIEW_ONLY" });
  view.take();
  assert.equal(f.live.controlled("a"), true);
  assert.deepEqual(owner.states.at(-1).control.holder, "phone");
  await view.input({
    type: "pointer",
    action: "down",
    x: 0.5,
    y: 0.5,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await view.input({ type: "paste", text: "geheim" });
  await assert.rejects(view.input({ type: "script" }), { code: "INVALID_INPUT" });
  assert.equal(f.dispatched.length, 2);
  assert.equal(f.dispatched[0].port, 4321);
  assert.equal(f.dispatched[0].targetId, "CDP-1");
  assert.deepEqual(f.dispatched[0].calls[0][1].x, 500);
  assert.deepEqual(f.dispatched[0].calls[0][1].y, 250);
  assert.deepEqual(f.dispatched[1].calls, [["Input.insertText", { text: "geheim" }]]);
  // Another login session sees it held and cannot take it.
  const other = f.live.subscribe("a", f.viewer().viewer, { holder: "laptop" });
  assert.throws(() => other.take(), { code: "LEASE_HELD" });
  assert.equal(other.handBack(), false);
  assert.equal(view.handBack(), true);
  assert.equal(f.live.controlled("a"), false);
  assert.deepEqual(f.handBacks, [["a", "owner"]]);
  for (const s of [view, preview, other]) s.close();
});

test("without input the lease warns, then hands the browser back", async () => {
  const f = fixture();
  const owner = f.viewer();
  const view = f.live.subscribe("a", owner.viewer, { holder: "phone" });
  await settle();
  view.take();
  const takeover = f.live.streams.get("a").takeover;
  f.tick(9 * 60_000 + 1);
  takeover.check();
  assert.equal(owner.states.at(-1).control.warning, true);
  // Any input renews it.
  f.gateway.sockets[0].emit("message", frame(800, 600), true);
  await view.input({ type: "key", action: "down", key: "a", code: "KeyA" });
  assert.equal(owner.states.at(-1).control.warning, false);
  f.tick(10 * 60_000);
  takeover.check();
  assert.equal(owner.states.at(-1).control, null);
  assert.deepEqual(f.handBacks, [["a", "timeout"]]);
  view.close();
});

test("a holder whose views all closed keeps the lease only for a short grace", async () => {
  const f = fixture();
  f.live.graceMs = 5;
  const view = f.live.subscribe("a", f.viewer().viewer, { holder: "phone" });
  await settle();
  view.take();
  view.close();
  // The reload comes back in time: the lease stays.
  const again = f.live.subscribe("a", f.viewer().viewer, { holder: "phone" });
  await settle();
  assert.equal(f.live.controlled("a"), true);
  again.close();
  await settle();
  assert.equal(f.live.controlled("a"), false);
  assert.deepEqual(f.handBacks, [["a", "left"]]);
  assert.equal(f.live.streams.size, 0);
});

test("a tab opened while the owner holds the browser is shown", async () => {
  const f = fixture();
  const owner = f.viewer();
  const view = f.live.subscribe("a", owner.viewer, { holder: "phone" });
  await settle();
  view.take();
  f.gateway.tabs = [...f.gateway.tabs, { targetId: "CDP-2", url: "https://login/" }];
  f.live.streams.get("a").wake();
  await settle();
  assert.equal(f.gateway.tickets.at(-1).targetId, "CDP-2");
  assert.equal(owner.states.at(-1).targetId, "CDP-2");
  view.close();
});

test("the tool guard keeps the agent waiting while the owner holds its browser", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "takeover-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const profiles = [{ id: "a", runtimeAgentId: "ap-a", capabilities: { browser: true } }];
  const browsers = new AgentBrowsers({
    store: { listAssistants: () => profiles, getAssistant: () => profiles[0] },
    runtime: {
      paths: { state },
      client: { ready: true, request: async () => ({}) },
      webTools: {
        browserProfiles: browserProfileMap({
          profiles,
          browser: { available: true, executablePath: "/b" },
          port: 1,
        }),
      },
    },
    keeper: () => ({ start: async () => true, close() {} }),
  });
  let held = true;
  browsers.controlled = () => held;
  assert.deepEqual(await browsers.policy({ agentId: "ap-a", action: "snapshot" }), {
    allow: false,
    reason: "ownerControl",
  });
  held = false;
  assert.equal(
    (await browsers.policy({ agentId: "ap-a", action: "snapshot" })).allow,
    true,
  );
});

test("handing back queues a note in the agent's latest chat, never over the owner's", () => {
  const queued = [];
  const conversations = {
    c1: { id: "c1", assistantId: "a" },
    c2: { id: "c2", assistantId: "b" },
    c3: { id: "c3", assistantId: "a" },
  };
  const assistants = {
    ledger: {
      latestByConversation: () => [
        { conversation_id: "c1" },
        { conversation_id: "c3" },
        { conversation_id: "c2" },
      ],
    },
    store: { getConversation: (id) => conversations[id] },
    queued: { get: (id) => (id === "busy" ? {} : null) },
    queue: (id, input) => queued.push([id, input.text]),
  };
  noteBrowserHandBack(assistants, "a", "owner");
  noteBrowserHandBack(assistants, "a", "timeout");
  assert.deepEqual(queued, [
    ["c3", serverMessages.assistants.browserHandedBack],
    ["c3", serverMessages.assistants.browserHandBackTimeout],
  ]);
  assistants.queued.get = () => ({ text: "owner's own" });
  noteBrowserHandBack(assistants, "a", "owner");
  assert.equal(queued.length, 2);
});
