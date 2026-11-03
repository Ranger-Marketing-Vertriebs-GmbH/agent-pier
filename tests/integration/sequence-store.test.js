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
  store.patch("p1", items[0].id, { state: "done", doneBy: "merge", doneAt: 9 });
  assert.equal(store.head("p1").key, "o/r#2");
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
  store.patch("p1", items[0].id, { state: "done" });
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
  for (const i of items) store.patch("p1", i.id, { state: "done" });
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
  assert.deepEqual(lines, ["ticket-sequences: dropped-invalid"]);
});
