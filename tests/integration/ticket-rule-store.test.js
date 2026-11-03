import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { ruleInput } from "../../server/features/tickets/rule-input.js";
import { TicketRuleMonitor } from "../../server/features/tickets/rule-monitor.js";

const dirs = [];
const dataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-rules-"));
  dirs.push(dir);
  return dir;
};
test.after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const input = (label, extra = {}) =>
  ruleInput({
    source: "github",
    label,
    kind: "session",
    session: { tool: "claude" },
    allowMerge: false,
    ...extra,
  });
const pick = (n, extra = {}) => ({
  source: "github",
  key: `o/r#${n}`,
  ruleId: "r",
  itemId: `i${n}`,
  at: n,
  ...extra,
});

test("rules and pickups survive a restart", () => {
  const dir = dataDir();
  let clock = 10;
  const store = new TicketRuleStore({ dataDir: dir, now: () => clock++ });
  const made = store.create("p1", input("agent"));
  store.update("p1", made.id, input("agent", { paused: true }));
  store.setStatus("p1", made.id, { checkedAt: 99, error: null, notified: null });
  store.addPickups("p1", [pick(1, { ruleId: made.id })]);
  const again = new TicketRuleStore({ dataDir: dir });
  assert.deepEqual(again.rules("p1"), store.rules("p1"));
  assert.equal(again.rule("p1", made.id).paused, true);
  assert.equal(again.rule("p1", made.id).status.checkedAt, 99);
  assert.equal(again.picked("p1", "github", "o/r#1").itemId, "i1");
  assert.equal(again.pickupCount("p1", made.id), 1);
  assert.equal(again.picked("p2", "github", "o/r#1"), null);
});

test("file is written 0600", () => {
  const dir = dataDir();
  const store = new TicketRuleStore({ dataDir: dir });
  store.create("p1", input("agent"));
  assert.equal(fs.statSync(path.join(dir, "ticket-rules.json")).mode & 0o777, 0o600);
});

test("damaged file is kept aside and the store starts empty", () => {
  for (const content of ["{nope", '{"rules":{}}', "[]"]) {
    const dir = dataDir();
    fs.writeFileSync(path.join(dir, "ticket-rules.json"), content);
    const store = new TicketRuleStore({ dataDir: dir, now: () => 7 });
    assert.deepEqual(store.allRules(), []);
    assert.ok(fs.existsSync(path.join(dir, "ticket-rules.json.corrupt-7")));
  }
});

test("invalid entries are dropped and logged", () => {
  const dir = dataDir();
  const store = new TicketRuleStore({ dataDir: dir });
  const made = store.create("p1", input("agent"));
  const file = path.join(dir, "ticket-rules.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.rules.push({ id: "x" }, { ...made });
  saved.pickups.push({ nope: 1 });
  fs.writeFileSync(file, JSON.stringify(saved));
  const logs = [];
  const again = new TicketRuleStore({ dataDir: dir, log: (m) => logs.push(m) });
  assert.equal(again.allRules().length, 1);
  assert.deepEqual(logs, ["ticket-rules: dropped-invalid count=3"]);
});

test("twenty-first rule is refused with 409", () => {
  const store = new TicketRuleStore({ dataDir: dataDir() });
  for (let i = 0; i < 20; i++) store.create("p1", input(`l${i}`));
  assert.throws(
    () => store.create("p1", input("one-more")),
    (e) => e.status === 409,
  );
  store.create("p2", input("one-more"));
});

test("same source and label differing only in case is refused with 409", () => {
  const store = new TicketRuleStore({ dataDir: dataDir() });
  const first = store.create("p1", input("Agent"));
  assert.throws(
    () => store.create("p1", input("agent")),
    (e) => e.status === 409,
  );
  store.create("p1", input("agent", { source: "plane" }));
  const other = store.create("p1", input("other"));
  assert.throws(
    () => store.update("p1", other.id, input("AGENT")),
    (e) => e.status === 409,
  );
  assert.equal(store.update("p1", first.id, input("AGENT")).label, "AGENT");
});

test("remove keeps pickups and unknown rules give 404", () => {
  const store = new TicketRuleStore({ dataDir: dataDir() });
  const made = store.create("p1", input("agent"));
  store.addPickups("p1", [pick(1, { ruleId: made.id })]);
  store.remove("p1", made.id);
  assert.equal(store.rule("p1", made.id), null);
  assert.ok(store.picked("p1", "github", "o/r#1"));
  assert.throws(
    () => store.remove("p1", made.id),
    (e) => e.status === 404,
  );
  assert.throws(
    () => store.update("p1", made.id, input("agent")),
    (e) => e.status === 404,
  );
  store.setStatus("p1", made.id, { checkedAt: 1 });
});

test("pickups are capped at 5000 per project, oldest dropped", () => {
  const dir = dataDir();
  const store = new TicketRuleStore({ dataDir: dir });
  store.addPickups(
    "p1",
    Array.from({ length: 5001 }, (_, i) => pick(i + 1)),
  );
  store.addPickups("p2", [pick(1)]);
  assert.equal(store.picked("p1", "github", "o/r#1"), null);
  assert.ok(store.picked("p1", "github", "o/r#2"));
  assert.ok(store.picked("p1", "github", "o/r#5001"));
  assert.ok(store.picked("p2", "github", "o/r#1"));
  const again = new TicketRuleStore({ dataDir: dir });
  assert.equal(again.picked("p1", "github", "o/r#1"), null);
  assert.ok(again.picked("p1", "github", "o/r#2"));
});

test("changing the label clears status error and notified", () => {
  const store = new TicketRuleStore({ dataDir: dataDir() });
  const made = store.create("p1", input("agent"));
  const status = { checkedAt: 5, error: { code: "auth", since: 4 }, notified: "auth" };
  store.setStatus("p1", made.id, status);
  const same = store.update("p1", made.id, input("agent", { paused: true }));
  assert.deepEqual(same.status, status);
  assert.equal(same.id, made.id);
  assert.equal(same.createdAt, made.createdAt);
  const moved = store.update("p1", made.id, input("other"));
  assert.deepEqual(moved.status, { checkedAt: 5, error: null, notified: null });
  store.setStatus("p1", made.id, status);
  const source = store.update("p1", made.id, input("other", { source: "plane" }));
  assert.equal(source.status.error, null);
});

test("failed save rolls back and returned rules are copies", () => {
  const dir = dataDir();
  const changes = [];
  const store = new TicketRuleStore({ dataDir: dir, onChange: (p) => changes.push(p) });
  const made = store.create("p1", input("agent"));
  store.addPickups("p1", [pick(1)]);
  assert.deepEqual(changes, ["p1", "p1"]);
  const before = store.rules("p1");
  // A directory in the file's place makes the atomic rename fail.
  const file = path.join(dir, "ticket-rules.json");
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => store.create("p1", input("second")));
  assert.throws(() => store.update("p1", made.id, input("renamed")));
  assert.throws(() => store.remove("p1", made.id));
  assert.throws(() => store.addPickups("p1", [pick(2)]));
  assert.throws(() => store.setStatus("p1", made.id, { checkedAt: 3 }));
  assert.deepEqual(store.rules("p1"), before);
  assert.equal(store.picked("p1", "github", "o/r#2"), null);
  assert.deepEqual(changes, ["p1", "p1"]);
  store.rules("p1")[0].label = "mutated";
  assert.equal(store.rules("p1")[0].label, "agent");
});

test("rules are sorted by createdAt", () => {
  let clock = 100;
  const store = new TicketRuleStore({ dataDir: dataDir(), now: () => clock-- });
  store.create("p1", input("a"));
  store.create("p1", input("b"));
  assert.deepEqual(
    store.rules("p1").map((r) => r.label),
    ["b", "a"],
  );
});

test("labels are checked and trimmed on load", () => {
  const dir = dataDir();
  const store = new TicketRuleStore({ dataDir: dir });
  const made = store.create("p1", input("agent"));
  const file = path.join(dir, "ticket-rules.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.rules = [
    { ...made, label: "  agent  " },
    { ...made, id: "b", label: "a,b" },
    { ...made, id: "c", label: "bad\u0007" },
    { ...made, id: "d", label: "   " },
    { ...made, id: "e", label: "AGENT" },
  ];
  fs.writeFileSync(file, JSON.stringify(saved));
  const logs = [];
  const again = new TicketRuleStore({ dataDir: dir, log: (m) => logs.push(m) });
  assert.deepEqual(
    again.allRules().map((r) => r.label),
    ["agent"],
  );
  // "AGENT" clashes with the trimmed "agent" and is dropped with the three invalid ones.
  assert.deepEqual(logs, ["ticket-rules: dropped-invalid count=4"]);
});

test("a file of an unknown version loads off and read-only and stays untouched", () => {
  const dir = dataDir();
  const file = path.join(dir, "ticket-rules.json");
  const content = JSON.stringify({ version: 2, rules: [{ id: "x" }], pickups: [] });
  fs.writeFileSync(file, content);
  const logs = [];
  const store = new TicketRuleStore({ dataDir: dir, log: (m) => logs.push(m) });
  assert.deepEqual(store.locked, { code: "unsupportedVersion", version: 2 });
  assert.deepEqual(logs, ["ticket-rules: unsupported version=2, rules disabled"]);
  assert.deepEqual(store.allRules(), []);
  const monitor = new TicketRuleMonitor({ rules: store, intervalMs: 60_000 });
  assert.equal(monitor.enabled, false);
  const refused = (run) =>
    assert.throws(
      run,
      (error) => error.status === 409 && error.code === "TICKET_RULES_LOCKED",
    );
  refused(() => store.create("p1", input("agent")));
  refused(() => store.update("p1", "x", input("agent")));
  refused(() => store.remove("p1", "x"));
  refused(() => store.addPickups("p1", [pick(1)]));
  store.setStatus("p1", "x", { checkedAt: 1 });
  assert.equal(fs.readFileSync(file, "utf8"), content);
  fs.writeFileSync(file, JSON.stringify({ rules: [], pickups: [] }));
  const plainFile = new TicketRuleStore({ dataDir: dir });
  assert.equal(plainFile.locked, null);
  assert.deepEqual(plainFile.allRules(), []);
});

test("a file that cannot be read loads off and read-only", () => {
  const dir = dataDir();
  fs.mkdirSync(path.join(dir, "ticket-rules.json"));
  const logs = [];
  const store = new TicketRuleStore({ dataDir: dir, log: (m) => logs.push(m) });
  assert.deepEqual(store.locked, { code: "unreadable" });
  assert.deepEqual(logs, ["ticket-rules: unreadable code=EISDIR, rules disabled"]);
  assert.throws(() => store.create("p1", input("agent")), { status: 409 });
  assert.ok(fs.statSync(path.join(dir, "ticket-rules.json")).isDirectory());
});
