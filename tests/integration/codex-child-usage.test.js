import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CodexChildUsage,
  lastTokenUsage,
} from "../../server/features/chat/codex-child-usage.js";
import { finalizeObservability } from "../../server/features/chat/chat-observability.js";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";

const usage = (input, output) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});
const record = (thread, input, output) => ({
  timestamp: "2026-10-01T10:00:00Z",
  ordinal: 1,
  type: "token_usage_record",
  payload: {
    thread_id: thread,
    turn_id: "turn1",
    session_id: thread,
    root_turn_id: "turn1",
    response_id: "resp1",
    usage: usage(1, 1),
    turn_token_usage: usage(1, 1),
    thread_token_usage: usage(input, output),
  },
});
const line = (value) => JSON.stringify(value) + "\n";

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-children-")));
  const outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "codex-foreign-")),
  );
  const root = path.join(home, ".codex");
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);`);
  const rollout = (id, records, directory = path.join(root, "sessions")) => {
    const file = path.join(directory, `rollout-${id}.jsonl`);
    fs.writeFileSync(
      file,
      line({ type: "session_meta", payload: { id } }) + records.map(line).join(""),
    );
    db.prepare("INSERT INTO threads VALUES (?, ?)").run(id, file);
    return file;
  };
  const edge = (parent, child) =>
    db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')").run(parent, child);
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  return {
    home,
    root,
    outside,
    db,
    rollout,
    edge,
    history: { home, environment: () => ({ HOME: home }) },
    session: { id: "local", tool: "codex", accountId: "one", cwd: home },
  };
}

test("Codex children come from spawn edges, roll grandchildren up and exclude foreign rollouts", async (t) => {
  const f = fixture(t);
  f.rollout("thread-a", [record("thread-a", 1000, 100), record("thread-a", 2000, 200)]);
  f.rollout("thread-a1", [record("thread-a1", 300, 30)]);
  f.rollout("thread-b", [record("thread-b", 50, 5)]);
  f.rollout("thread-foreign", [record("thread-foreign", 9, 9)], f.outside);
  f.rollout("thread-new", []);
  for (const [parent, child] of [
    ["thread-parent", "thread-a"],
    ["thread-a", "thread-a1"],
    ["thread-parent", "thread-b"],
    ["thread-parent", "thread-foreign"],
    ["thread-parent", "thread-missing"],
    ["thread-parent", "thread-new"],
    ["thread-other", "thread-x"],
  ])
    f.edge(parent, child);
  const children = new CodexChildUsage();
  const value = await children.read(f.history, f.session, "thread-parent");
  assert.deepEqual(Object.keys(value.agents).sort(), ["thread-a", "thread-b"]);
  assert.equal(value.agents["thread-a"].totalTokens, 2200 + 330);
  assert.equal(value.agents["thread-b"].totalTokens, 55);
  assert.equal(value.unavailable, 2);
  const final = finalizeObservability(
    {
      context: {},
      subagents: [{ id: "thread-a", name: "", task: "", status: "completed" }],
      totals: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "codex-thread" },
      subagentUsage: value,
    },
    { status: "running", tool: "codex" },
  );
  assert.equal(final.subagents[0].usage.totalTokens, 2530);
  assert.deepEqual(
    [
      final.totals.subagents.count,
      final.totals.subagents.unavailable,
      final.totals.subagents.totalTokens,
    ],
    [2, 2, 2585],
  );
  assert.equal(await children.read(f.history, f.session, "thread-none"), null);
});

test("child usage is read backwards, skips an unfinished append and is cached by size and mtime", async (t) => {
  const f = fixture(t);
  const file = f.rollout("thread-a", [
    record("thread-a", 1000, 100),
    { type: "event_msg", payload: { type: "agent_message", message: "x".repeat(70000) } },
  ]);
  const late = JSON.stringify(record("thread-a", 5000, 500));
  fs.appendFileSync(file, late.slice(0, 60));
  f.edge("thread-parent", "thread-a");
  assert.equal((await lastTokenUsage(file, "thread-a")).totalTokens, 1100);
  const children = new CodexChildUsage();
  await children.read(f.history, f.session, "thread-parent");
  const reads = children.reads;
  await children.read(f.history, f.session, "thread-parent");
  assert.equal(children.reads, reads);
  fs.appendFileSync(file, late.slice(60) + "\n");
  const value = await children.read(f.history, f.session, "thread-parent");
  assert.equal(children.reads, reads + 1);
  assert.equal(value.agents["thread-a"].totalTokens, 5500);
  const quiet = path.join(f.root, "sessions", "quiet.jsonl");
  fs.writeFileSync(
    quiet,
    line(record("thread-q", 1, 1)) +
      line({
        type: "event_msg",
        payload: { type: "agent_message", message: "y".repeat(200000) },
      }),
  );
  assert.equal(await lastTokenUsage(quiet, "thread-q", { maxBytes: 64 * 1024 }), null);
});

test("an inconsistent or unsupported state database is skipped without failing", async (t) => {
  const f = fixture(t);
  f.edge("thread-parent", "thread-a");
  const wal = path.join(f.root, "state_5.sqlite-wal");
  fs.writeFileSync(wal, "");
  assert.equal(
    await new CodexChildUsage().read(f.history, f.session, "thread-parent"),
    null,
  );
  fs.rmSync(wal);
  f.db.exec("DROP TABLE thread_spawn_edges");
  assert.equal(
    await new CodexChildUsage().read(f.history, f.session, "thread-parent"),
    null,
  );
});

test("the first Codex page carries thread totals and child usage", async (t) => {
  const f = fixture(t);
  f.rollout("thread-a", [record("thread-a", 10, 1)]);
  f.edge("native-parent", "thread-a");
  const parent = path.join(f.root, "sessions", "rollout-parent.jsonl");
  fs.writeFileSync(
    parent,
    line({ type: "session_meta", payload: { id: "native-parent", cwd: f.home } }) +
      line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn1" } }) +
      line(record("native-parent", 100, 10)),
  );
  const history = new ProviderHistory({
    home: f.home,
    accounts: { get: () => ({ tool: "codex" }), environment: () => ({ HOME: f.home }) },
  });
  t.after(() => history.close());
  history.codex = () => ({
    request: async (method) =>
      method === "thread/read"
        ? {
            thread: {
              id: "native-parent",
              cwd: f.home,
              path: parent,
              turns: [{ id: "turn1", items: [] }],
            },
          }
        : { data: [{ id: "turn1", items: [] }], nextCursor: null },
  });
  const page = await history.readPage(f.session, "native-parent");
  assert.equal(page.observability.totals.totalTokens, 110);
  assert.equal(page.observability.subagentUsage.agents["thread-a"].totalTokens, 11);
});
