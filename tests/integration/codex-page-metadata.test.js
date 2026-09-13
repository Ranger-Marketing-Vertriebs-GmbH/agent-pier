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
