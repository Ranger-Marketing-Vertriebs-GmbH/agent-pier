import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readOpenCodePage } from "../../server/features/chat/opencode-history-page.js";
import { finalizeObservability } from "../../server/features/chat/chat-observability.js";

function fixture(t, { tokenColumns = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-tokens-"));
  const root = path.join(home, "data");
  fs.mkdirSync(path.join(root, "opencode"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "opencode", "opencode.db"));
  const totals = tokenColumns
    ? ", parent_id TEXT, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER"
    : "";
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, revert TEXT${totals});
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
    CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);
  `);
  const session = (id, values = {}) => {
    const columns = ["id", "directory", "time_created", "revert", ...Object.keys(values)];
    db.prepare(
      `INSERT INTO session(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(id, home, 1, null, ...Object.values(values));
  };
  const message = (index, parts) => {
    const id = `msg_${String(index).padStart(6, "0")}`;
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      id,
      "ses_parent",
      index,
      JSON.stringify({
        role: "assistant",
        time: { created: index, completed: index + 1 },
        modelID: "gpt-5",
        tokens: { input: 42, cache: { read: 3, write: 0 } },
      }),
    );
    parts.forEach((part, n) =>
      db
        .prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
        .run(
          `${id}_p${String(n).padStart(6, "0")}`,
          "ses_parent",
          id,
          JSON.stringify(part),
        ),
    );
  };
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    session,
    message,
    local: { id: "local", tool: "opencode", accountId: "one", cwd: home },
    history: {
      home,
      environment: () => ({ HOME: home, XDG_DATA_HOME: root }),
      read: () => {
        throw Error("must not export");
      },
    },
  };
}
const row = (cost, input, output, reasoning, read, write, extra = {}) => ({
  cost,
  tokens_input: input,
  tokens_output: output,
  tokens_reasoning: reasoning,
  tokens_cache_read: read,
  tokens_cache_write: write,
  ...extra,
});

test("OpenCode totals and cost come from the session row and children from child rows", async (t) => {
  const f = fixture(t);
  f.session(
    "ses_parent",
    row(0.75, 1000, 200, 50, 4000, 100, { time_updated: 1759312800000 }),
  );
  f.session("ses_child_a", row(0.25, 100, 20, 5, 400, 10, { parent_id: "ses_parent" }));
  f.session("ses_child_b", row(0.05, 10, 2, 0, 40, 1, { parent_id: "ses_parent" }));
  f.session("ses_other", row(9, 9, 9, 9, 9, 9, { parent_id: "ses_unrelated" }));
  f.message(1, [
    {
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: { subagent_type: "explore", description: "Scan the parser" },
        metadata: { sessionId: "ses_child_a" },
        time: { start: 1, end: 2 },
      },
    },
  ]);
  const page = await readOpenCodePage(f.history, f.local, "ses_parent");
  const totals = page.observability.totals;
  assert.deepEqual(
    [totals.totalTokens, totals.reasoningTokens, totals.source, totals.observedAt],
    [5350, 50, "opencode-session", "2025-10-01T10:00:00.000Z"],
  );
  assert.deepEqual(totals.cost, { usd: 0.75, scope: "session" });
  assert.deepEqual(Object.keys(page.observability.subagentUsage.agents), [
    "ses_child_a",
    "ses_child_b",
  ]);
  const final = finalizeObservability(page.observability, {
    status: "running",
    tool: "opencode",
  });
  const child = final.subagents.find((agent) => agent.id === "ses_child_a");
  assert.deepEqual([child.usage.totalTokens, child.usage.costUsd], [535, 0.25]);
  assert.deepEqual(
    [final.totals.subagents.count, final.totals.subagents.totalTokens],
    [2, 535 + 53],
  );
  assert.ok(Math.abs(final.totals.subagents.costUsd - 0.3) < 1e-9);
  assert.equal(final.totals.totalTokens, 5350);
});

test("only the first page attaches session totals", async (t) => {
  const f = fixture(t);
  f.session("ses_parent", row(0.1, 1, 1, 0, 0, 0));
  for (let i = 0; i < 60; i++) f.message(i, [{ type: "text", text: `${i}` }]);
  const first = await readOpenCodePage(f.history, f.local, "ses_parent");
  assert.equal(first.observability.totals.totalTokens, 2);
  assert.ok(first.next);
  const older = await readOpenCodePage(f.history, f.local, "ses_parent", first.next);
  assert.equal(older.observability.totals, undefined);
  assert.equal(older.observability.subagentUsage, undefined);
});

test("databases without token columns keep paging and report no totals", async (t) => {
  const f = fixture(t, { tokenColumns: false });
  f.session("ses_parent");
  f.message(1, [{ type: "text", text: "Hello" }]);
  const page = await readOpenCodePage(f.history, f.local, "ses_parent");
  assert.ok(page.messages.length > 0);
  assert.equal(page.observability.totals, null);
  assert.equal(page.observability.subagentUsage, null);
});
