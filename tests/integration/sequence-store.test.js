import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketSequenceStore } from "../../server/features/tickets/sequence-store.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const dirs = [];
const dataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-seq-"));
  dirs.push(dir);
  return dir;
};
test.after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const walk = (store, id, ...states) =>
  states.forEach((state) => store.patch("p1", id, { state }));
const finish = (store, id, extra = {}) => {
  walk(store, id, "running", "awaiting-merge");
  return store.patch("p1", id, { state: "done", ...extra });
};

const entry = (n, extra = {}) => ({
  source: "github",
  key: `o/r#${n}`,
  title: `Ticket ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
  kind: "session",
  options: { session: { tool: "claude" }, allowMerge: false },
  ...extra,
});

test("append keeps order and persists across instances", () => {
  const dir = dataDir();
  const store = new TicketSequenceStore({ dataDir: dir, now: () => 5 });
  store.append("p1", "/repo", [entry(1), entry(2)]);
  store.append("p1", "/repo", [entry(3)]);
  const again = new TicketSequenceStore({ dataDir: dir });
  const queue = again.queue("p1");
  assert.equal(queue.repoPath, "/repo");
  assert.deepEqual(
    queue.items.map((i) => i.key),
    ["o/r#1", "o/r#2", "o/r#3"],
  );
  assert.equal(queue.items[0].state, "waiting");
  assert.equal(queue.items[0].addedAt, 5);
  assert.equal(again.head("p1").key, "o/r#1");
  assert.equal(again.queues().length, 1);
  assert.equal(again.queue("other"), null);
});

test("patch persists and head skips done items; needs-owner head blocks", () => {
  const dir = dataDir();
  const store = new TicketSequenceStore({ dataDir: dir });
  const { items } = store.append("p1", "/repo", [entry(1), entry(2)]);
  finish(store, items[0].id, { doneBy: "merge", doneAt: 9 });
  assert.equal(store.head("p1").key, "o/r#2");
  walk(store, items[1].id, "running");
  store.patch("p1", items[1].id, {
    state: "needs-owner",
    needsOwner: { reason: "closed", at: 1 },
    pr: { number: 3, url: "https://x/pr/3", headRef: "b" },
  });
  assert.equal(store.head("p1").state, "needs-owner");
  const reloaded = new TicketSequenceStore({ dataDir: dir }).queue("p1").items;
  assert.equal(reloaded[0].doneBy, "merge");
  assert.equal(reloaded[1].pr.number, 3);
  assert.throws(() => store.patch("p1", "nope", {}), { status: 404 });
  store.remove("p1", items[1].id);
  assert.equal(store.head("p1"), null);
  assert.throws(() => store.remove("p1", items[1].id), { status: 404 });
});

test("rejects an active duplicate but allows one whose earlier item is done", () => {
  const store = new TicketSequenceStore({ dataDir: dataDir() });
  const { items } = store.append("p1", "/repo", [entry(1)]);
  assert.throws(() => store.append("p1", "/repo", [entry(1)]), {
    status: 409,
    message: serverMessages.tickets.ticketQueued,
  });
  assert.throws(() => store.append("p1", "/repo", [entry(2), entry(2)]), {
    status: 409,
  });
  assert.equal(store.queue("p1").items.length, 1);
  finish(store, items[0].id);
  store.append("p1", "/repo", [entry(1)]);
  assert.equal(store.queue("p1").items.length, 2);
});

test("rejects more than 200 active items", () => {
  const store = new TicketSequenceStore({ dataDir: dataDir() });
  for (let i = 0; i < 4; i += 1)
    store.append(
      "p1",
      "/repo",
      Array.from({ length: 50 }, (_, n) => entry(i * 50 + n + 1)),
    );
  assert.throws(() => store.append("p1", "/repo", [entry(999)]), {
    status: 409,
    message: serverMessages.tickets.sequenceFull,
  });
});

test("rule items append behind manual items", () => {
  const dir = dataDir();
  const store = new TicketSequenceStore({ dataDir: dir });
  store.append("p1", "/repo", [entry(1)]);
  store.append("p1", "/repo", [entry(2, { origin: { kind: "rule", ruleId: "r1" } })]);
  store.append("p1", "/repo", [entry(3)]);
  const items = new TicketSequenceStore({ dataDir: dir }).queue("p1").items;
  assert.deepEqual(
    items.map((i) => i.key),
    ["o/r#1", "o/r#2", "o/r#3"],
  );
  assert.deepEqual(items[1].origin, { kind: "rule", ruleId: "r1" });
  assert.deepEqual(items[0].origin, { kind: "manual" });
});

test("file is private", () => {
  const dir = dataDir();
  const store = new TicketSequenceStore({ dataDir: dir });
  store.append("p1", "/repo", [entry(1)]);
  assert.equal(fs.statSync(path.join(dir, "ticket-sequences.json")).mode & 0o777, 0o600);
});

test("prunes done items to 50", () => {
  const store = new TicketSequenceStore({ dataDir: dataDir() });
  const { items } = store.append(
    "p1",
    "/repo",
    Array.from({ length: 50 }, (_, n) => entry(n + 1)),
  );
  store.append(
    "p1",
    "/repo",
    Array.from({ length: 10 }, (_, n) => entry(n + 51)),
  );
  for (const i of items) finish(store, i.id);
  store.append("p1", "/repo", [entry(100)]);
  const queue = store.queue("p1").items;
  assert.equal(queue.filter((i) => i.state === "done").length, 50);
  assert.equal(queue.filter((i) => i.state === "waiting").length, 11);
  const store2 = new TicketSequenceStore({ dataDir: store.file.replace(/[^/]+$/, "") });
  assert.equal(store2.queue("p1").items.length, 61);
});

test("a corrupt file loads empty and is kept; invalid items are dropped", () => {
  const dir = dataDir();
  const file = path.join(dir, "ticket-sequences.json");
  fs.writeFileSync(file, "{ nope");
  const store = new TicketSequenceStore({ dataDir: dir, now: () => 42 });
  assert.deepEqual(store.queues(), []);
  assert.ok(fs.existsSync(`${file}.corrupt-42`));

  const good = new TicketSequenceStore({ dataDir: dir });
  good.append("p1", "/repo", [entry(1)]);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.queues.p1.items.push({ id: "x", source: "github", key: "k", state: "bogus" });
  fs.writeFileSync(file, JSON.stringify(saved));
  const lines = [];
  const loaded = new TicketSequenceStore({ dataDir: dir, log: (l) => lines.push(l) });
  assert.equal(loaded.queue("p1").items.length, 1);
  assert.deepEqual(lines, ["ticket-sequences: dropped-invalid count=1"]);
});

test("a failed save after pruning restores the previous items", () => {
  const store = new TicketSequenceStore({ dataDir: dataDir() });
  const { items } = store.append(
    "p1",
    "/repo",
    Array.from({ length: 52 }, (_, n) => entry(n + 1)),
  );
  // Walk 51 items through the legal path to done (51st prunes the oldest).
  for (const i of items.slice(0, 50)) {
    store.patch("p1", i.id, { state: "running" });
    store.patch("p1", i.id, { state: "awaiting-merge" });
    store.patch("p1", i.id, { state: "done" });
  }
  const last = items[50];
  store.patch("p1", last.id, { state: "running" });
  store.patch("p1", last.id, { state: "awaiting-merge" });
  const before = store.queue("p1").items;
  store.save = () => {
    throw new Error("disk full");
  };
  assert.throws(() => store.patch("p1", last.id, { state: "done" }), /disk full/);
  assert.deepEqual(store.queue("p1").items, before);
});

test("only legal state transitions are accepted", () => {
  const store = new TicketSequenceStore({ dataDir: dataDir() });
  const { items } = store.append("p1", "/repo", [entry(1)]);
  const id = items[0].id;
  const to = (state) => store.patch("p1", id, { state });
  const refuses = (state) =>
    assert.throws(() => to(state), {
      status: 409,
      message: serverMessages.tickets.invalidSequence,
    });
  refuses("done");
  refuses("awaiting-merge");
  to("running");
  refuses("waiting");
  to("awaiting-merge");
  to("running");
  to("awaiting-merge");
  to("needs-owner");
  to("waiting");
  to("running");
  to("needs-owner");
  to("done");
  for (const state of ["waiting", "running", "awaiting-merge", "needs-owner"])
    refuses(state);
  assert.equal(store.queue("p1").items[0].state, "done");
});

test("valid JSON of the wrong shape is kept aside like a corrupt file", () => {
  const dir = dataDir();
  const file = path.join(dir, "ticket-sequences.json");
  fs.writeFileSync(file, "[]");
  const store = new TicketSequenceStore({ dataDir: dir, now: () => 7 });
  assert.deepEqual(store.queues(), []);
  assert.equal(fs.readFileSync(`${file}.corrupt-7`, "utf8"), "[]");
});

test("queue and head return copies", () => {
  const store = new TicketSequenceStore({ dataDir: dataDir() });
  store.append("p1", "/repo", [entry(1)]);
  store.queue("p1").items[0].state = "done";
  store.head("p1").title = "changed";
  store.queues()[0].items.length = 0;
  assert.equal(store.queue("p1").items[0].state, "waiting");
  assert.equal(store.head("p1").title, "Ticket 1");
});

test("a done item whose write-back was cut off loads as failed (interrupted)", () => {
  const dir = dataDir();
  const store = new TicketSequenceStore({ dataDir: dir });
  const [first, second] = store.append("p1", "/repo", [entry(1), entry(2)]).items;
  finish(store, first.id, { doneBy: "merge", writeBack: { state: "pending" } });
  finish(store, second.id, { doneBy: "merge", writeBack: { state: "done" } });
  const again = new TicketSequenceStore({ dataDir: dir });
  const [one, two] = again.queue("p1").items;
  assert.deepEqual(one.writeBack, { state: "failed", code: "interrupted" });
  assert.deepEqual(two.writeBack, { state: "done" });
});

test("armedHead and refused round-trip; invalid values are dropped", () => {
  const dir = dataDir();
  const store = new TicketSequenceStore({ dataDir: dir });
  const [item] = store.append("p1", "/repo", [entry(1)]).items;
  walk(store, item.id, "running", "awaiting-merge");
  store.patch("p1", item.id, {
    armed: "auto",
    armedHead: "a".repeat(40),
    refused: { headSha: "b".repeat(40), what: "merge", code: "invalidResponse" },
  });
  const loaded = new TicketSequenceStore({ dataDir: dir }).queue("p1").items[0];
  assert.equal(loaded.armedHead, "a".repeat(40));
  assert.deepEqual(loaded.refused, {
    headSha: "b".repeat(40),
    what: "merge",
    code: "invalidResponse",
  });
  const cleared = store.patch("p1", item.id, {
    armedHead: null,
    refused: { headSha: "c", what: "other" },
  });
  assert.equal(cleared.armedHead, null);
  assert.equal(cleared.refused, undefined);
});
