import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";
import { ChatStore } from "../../server/features/chat/chat-store.js";
const records = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/observability/${name}.json`, import.meta.url),
      "utf8",
    ),
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
test("Claude history and saved Chat snapshots preserve observed context with an explicit stale marker", async (t) => {
  const f = fixture(t, "claude");
  const id = "native-parent",
    folder = path.join(
      f.home,
      ".claude",
      "projects",
      f.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    );
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, `${id}.jsonl`),
    [
      { type: "user", cwd: f.cwd, sessionId: id, message: { content: "Fixture" } },
      ...records("claude"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const chat = new ChatStore({
    dataDir: f.dataDir,
    sessions: { get: async () => f.session },
    history: f.history,
  });
  chat.initialize(f.session, id, "automatic");
  const first = await chat.read(f.session.id);
  assert.equal(first.observability.context.usedTokens, 60);
  assert.equal(first.observability.stale, false);
  const source = first.observability.context.source;
  f.session.status = "stopped";
  chat.cache.clear();
  f.history.read = async () => {
    throw Error("Fixture history offline");
  };
  const saved = await chat.read(f.session.id);
  assert.equal(saved.observability.stale, true);
  assert.equal(saved.observability.context.source, source);
  assert.equal(
    saved.observability.context.observedAt,
    first.observability.context.observedAt,
  );
});
test("Codex reuses already scoped rollout and app-server reads for observability", async (t) => {
  const f = fixture(t, "codex");
  const file = path.join(f.home, ".codex", "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      { type: "session_meta", payload: { id: "native-parent", cwd: f.cwd } },
      ...records("codex"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  let calls = 0;
  f.history.codex = () => ({
    request: async (method) => {
      assert.equal(method, "thread/read");
      calls++;
      return { thread: { id: "native-parent", cwd: f.cwd, path: file, turns: [] } };
    },
  });
  const result = await f.history.read(f.session, "native-parent");
  assert.equal(result.observability.context.usedTokens, 70000);
  assert.equal(result.observability.subagents.length, 2);
  assert.equal(calls, 2);
});
test("OpenCode enriches one existing native export and never launches a second observability query", async (t) => {
  const f = fixture(t, "opencode");
  let calls = 0;
  f.history.opencode = async (_session, args) => {
    calls++;
    assert.deepEqual(args, ["export", "native-parent"]);
    const value = records("opencode");
    value.info.directory = f.cwd;
    return value;
  };
  const result = await f.history.read(f.session, "native-parent");
  assert.equal(result.observability.context.usedTokens, 6000);
  assert.equal(result.observability.subagents.length, 2);
  assert.equal(calls, 1);
});
