import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const { AccountStore } = await import(
  new URL("../../server/features/accounts/account-store.js", import.meta.url)
);
const { ProviderHistory } = await import(
  new URL("../../server/features/chat/provider-history.js", import.meta.url)
);
const { ChatStore } = await import(
  new URL("../../server/features/chat/chat-store.js", import.meta.url)
);
const { observeCodex } = await import(
  new URL("../../server/features/chat/codex-observability.js", import.meta.url)
);
function fixture(t, tool) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-observability-")),
  );
  const dataDir = path.join(root, "data"),
    home = path.join(root, "home"),
    cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir, home });
  const history = new ProviderHistory({ accounts, home });
  const session = {
    id: "fixture-session",
    accountId: `local-${tool}`,
    tool,
    cwd,
    status: "running",
  };
  t.after(async () => {
    await history.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, cwd, dataDir, history, session };
}

test("paginated Codex retains native usage and plan metadata", async (t) => {
  const f = fixture(t, "codex");
  const file = path.join(f.home, ".codex", "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      { type: "session_meta", payload: { id: "native-parent", cwd: f.cwd } },
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn1" },
      },
      { type: "turn_context", payload: { model: "gpt-5" } },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 70000 },
            model_context_window: 200000,
          },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "plan1",
          name: "update_plan",
          arguments: JSON.stringify({
            plan: [{ step: "Build", status: "in_progress" }],
          }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "plan1",
          output: "Plan updated",
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  f.history.codex = () => ({
    request: async (method) =>
      method === "thread/read"
        ? {
            thread: {
              id: "native-parent",
              cwd: f.cwd,
              path: file,
              turns: [{ id: "turn1", items: [] }],
            },
          }
        : { data: [{ id: "turn1", items: [] }], nextCursor: null },
  });
  const legacy = await f.history.read(f.session, "native-parent");
  const paginated = await f.history.readPage(f.session, "native-parent");
  const chat = new ChatStore({
    dataDir: f.dataDir,
    sessions: { get: async () => f.session },
    history: f.history,
  });
  chat.initialize(f.session, "native-parent");
  const production = await chat.read(f.session.id);

  assert.equal(
    production.observability.context.usedTokens,
    legacy.observability.context.usedTokens,
  );
  assert.deepEqual(paginated.tasks, legacy.tasks);
});

test("rollout metadata reads complete appends and resets on replacement", async (t) => {
  const f = fixture(t, "codex");
  const file = path.join(f.home, ".codex", "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const meta = { type: "session_meta", payload: { id: "native-parent", cwd: f.cwd } };
  const usage = (used) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: used }, model_context_window: 200000 },
    },
  });
  const line = (r) => JSON.stringify(r) + "\n";
  fs.writeFileSync(file, line(meta) + line(usage(100)));
  const thread = { id: "native-parent", path: file };
  const read = () => f.history.codexMetadata.read(f.history, f.session, thread);
  await read();
  const entry = [...f.history.codexMetadata.entries.values()][0];
  const firstOffset = entry.offset;
  fs.appendFileSync(file, JSON.stringify(usage(200)));
  assert.equal(
    (await read()).find((r) => r.payload?.type === "token_count").payload.info
      .last_token_usage.total_tokens,
    100,
  );
  assert.equal(entry.offset, firstOffset);
  fs.appendFileSync(file, "\n");
  assert.equal(
    (await read()).find((r) => r.payload?.type === "token_count").payload.info
      .last_token_usage.total_tokens,
    200,
  );
  fs.writeFileSync(file, line(meta) + line(usage(10)));
  assert.equal(
    (await read()).find((r) => r.payload?.type === "token_count").payload.info
      .last_token_usage.total_tokens,
    10,
  );
});

test("rollout metadata projects thread totals, process totals and rate limits incrementally", async (t) => {
  const f = fixture(t, "codex");
  const file = path.join(f.home, ".codex", "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: input - 100,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 5,
    total_tokens: input + output,
  });
  const record = (input, output) => ({
    timestamp: "2026-10-01T10:00:00Z",
    ordinal: 1,
    type: "token_usage_record",
    payload: {
      thread_id: "native-parent",
      turn_id: "turn1",
      session_id: "native-parent",
      root_turn_id: "turn1",
      response_id: "resp1",
      usage: usage(101, 1),
      turn_token_usage: usage(101, 1),
      thread_token_usage: usage(input, output),
    },
  });
  const count = {
    timestamp: "2026-10-01T10:00:01Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(300, 30),
        last_token_usage: usage(300, 30),
        model_context_window: 272000,
      },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: 12.5, window_minutes: 10080, resets_at: 4102444800 },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: "0" },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: "pro",
        rate_limit_reached_type: null,
      },
    },
  };
  const line = (r) => JSON.stringify(r) + "\n";
  fs.writeFileSync(
    file,
    line({ type: "session_meta", payload: { id: "native-parent", cwd: f.cwd } }) +
      line(record(5000, 400)) +
      line(count),
  );
  const thread = { id: "native-parent", path: file };
  const read = () => f.history.codexMetadata.read(f.history, f.session, thread);
  const first = observeCodex(thread, await read());
  assert.deepEqual(
    [first.totals.totalTokens, first.totals.source],
    [5400, "codex-thread"],
  );
  assert.equal(first.limits.buckets[0].windows[0].usedPercent, 12.5);
  assert.equal(first.context.usedTokens, 330);
  const entry = [...f.history.codexMetadata.entries.values()][0];
  const offset = entry.offset;
  fs.appendFileSync(file, line(record(9000, 700)));
  const records = await read();
  assert.ok(entry.offset > offset);
  assert.equal(records.filter((r) => r.type === "token_usage_record").length, 1);
  const next = observeCodex(thread, records);
  assert.equal(next.totals.totalTokens, 9700);
  assert.equal(next.context.usedTokens, 330);
  assert.equal(JSON.stringify(records).includes("resp1"), false);
});

test("rollout metadata keeps the parent thread usage, bounded limits and the last context", async () => {
  const { CodexRolloutMetadata } = await import(
    new URL("../../server/features/chat/codex-rollout-metadata.js", import.meta.url)
  );
  const meta = new CodexRolloutMetadata();
  const usage = (total) => ({
    input_tokens: total,
    output_tokens: 0,
    total_tokens: total,
  });
  const usageRecord = (thread, total) => ({
    type: "token_usage_record",
    timestamp: "2026-10-01T10:00:00Z",
    payload: { thread_id: thread, thread_token_usage: usage(total) },
  });
  const fresh = () => ({ records: new Map(), plans: new Map(), agents: [] });
  const run = (entry, items) => {
    for (const item of items) meta.update(entry, item);
    return [...entry.records.values()].flat();
  };
  const known = run(fresh(), [
    { type: "session_meta", payload: { id: "parent" } },
    usageRecord("parent", 1000),
    usageRecord("child", 5),
  ]);
  assert.equal(observeCodex({ id: "parent" }, known).totals.totalTokens, 1000);
  const late = run(fresh(), [
    usageRecord("parent", 1000),
    usageRecord("child", 5),
    { type: "session_meta", payload: { id: "parent" } },
  ]);
  assert.equal(observeCodex({ id: "parent" }, late).totals.totalTokens, 1000);
  const big = "9".repeat(100_000);
  const limited = run(fresh(), [
    {
      type: "event_msg",
      timestamp: "2026-10-01T10:00:00Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 300 }, model_context_window: 1000 },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-10-01T10:00:01Z",
      payload: {
        type: "token_count",
        info: null,
        rate_limits: {
          limit_id: "codex",
          extra: big,
          primary: { used_percent: 5, window_minutes: 300, resets_at: 4102444800, big },
          credits: { has_credits: true, unlimited: false, balance: big },
        },
      },
    },
  ]);
  assert.ok(JSON.stringify(limited).length < 2000);
  assert.equal(observeCodex({}, limited).context.usedTokens, 300);
});
