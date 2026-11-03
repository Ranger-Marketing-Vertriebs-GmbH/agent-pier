import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ticketQueueChanged,
  ticketRulesChanged,
  ticketRulesTopic,
  ticketsQueueTopic,
} from "../../server/features/tickets/live-topics.js";
import { TicketSequenceStore } from "../../server/features/tickets/sequence-store.js";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { ruleInput } from "../../server/features/tickets/rule-input.js";

const entry = (n) => ({
  source: "github",
  key: `acme/app#${n}`,
  title: `T${n}`,
  url: "",
  kind: "session",
  options: { allowMerge: false, session: { tool: "claude" } },
});

test("tickets.queue is owner-only and signalled on every store change", async (t) => {
  const view = { queue: { items: [] }, defaults: { repair: null } };
  const read = [];
  const topic = ticketsQueueTopic({
    ticketSequences: { view: async (id) => (read.push(id), view) },
  });
  assert.equal(topic.name, "tickets.queue");
  assert.equal(topic.mode, "state");
  assert.equal(topic.authorize({ role: "owner" }), true);
  assert.equal(topic.authorize({ role: "user", userId: "u1" }), false);
  assert.equal(topic.authorize(undefined), false);
  assert.equal(topic.scopeKey({ role: "owner" }), "owner");
  assert.equal(topic.param.test("p1"), true);
  assert.equal(topic.param.test("../p1"), false);
  assert.deepEqual(await topic.read({ role: "owner" }, "p1"), view);
  assert.deepEqual(read, ["p1"]);

  const signals = [];
  const hub = { invalidate: (...args) => signals.push(args) };
  ticketQueueChanged(hub, "p1");
  ticketQueueChanged(null, "p1");
  ticketQueueChanged(hub, undefined);
  assert.deepEqual(signals, [["tickets.queue", "p1"]]);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-seq-topic-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  signals.length = 0;
  const store = new TicketSequenceStore({
    dataDir,
    onChange: (projectId) => ticketQueueChanged(hub, projectId),
  });
  const { items } = store.append("p1", "/repo", [entry(1), entry(2)]);
  store.patch("p1", items[0].id, { state: "running" });
  store.remove("p1", items[1].id);
  assert.throws(() => store.patch("p1", items[0].id, { state: "waiting" }));
  assert.deepEqual(signals, [
    ["tickets.queue", "p1"],
    ["tickets.queue", "p1"],
    ["tickets.queue", "p1"],
  ]);
});

test("tickets.rules is owner-only and reads the rule view", async () => {
  const view = { rules: [] };
  const read = [];
  const topic = ticketRulesTopic({
    ticketRules: { view: (id) => (read.push(id), view) },
  });
  assert.equal(topic.name, "tickets.rules");
  assert.equal(topic.mode, "state");
  assert.equal(topic.authorize({ role: "owner" }), true);
  assert.equal(topic.authorize({ role: "user", userId: "u1" }), false);
  assert.equal(topic.authorize(undefined), false);
  assert.equal(topic.scopeKey({ role: "owner" }), "owner");
  assert.equal(topic.param.test("p1"), true);
  assert.equal(topic.param.test("../p1"), false);
  assert.deepEqual(await topic.read({ role: "owner" }, "p1"), view);
  assert.deepEqual(read, ["p1"]);
});

test("a rule change invalidates tickets.rules:<projectId>", (t) => {
  const signals = [];
  const hub = { invalidate: (...args) => signals.push(args) };
  ticketRulesChanged(hub, "p1");
  ticketRulesChanged(null, "p1");
  ticketRulesChanged(hub, undefined);
  assert.deepEqual(signals, [["tickets.rules", "p1"]]);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-rule-topic-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  signals.length = 0;
  const store = new TicketRuleStore({
    dataDir,
    onChange: (projectId) => ticketRulesChanged(hub, projectId),
  });
  const checked = ruleInput({
    source: "github",
    label: "agent",
    kind: "session",
    allowMerge: false,
    session: { tool: "claude" },
  });
  const rule = store.create("p1", checked);
  store.update("p1", rule.id, { ...checked, paused: true });
  store.setStatus("p1", rule.id, { checkedAt: 1, error: null, notified: null });
  store.addPickups("p1", [
    { source: "github", key: "acme/app#1", ruleId: rule.id, itemId: "i1", at: 1 },
  ]);
  store.remove("p1", rule.id);
  assert.throws(() => store.remove("p1", rule.id));
  assert.deepEqual(signals, Array(5).fill(["tickets.rules", "p1"]));
});
