import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";
import { readHistoryPage } from "../../server/features/chat/history-page.js";
import { JsonlHistoryReader } from "../../server/features/chat/jsonl-history-reader.js";
import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { applyChatSync } from "../../web/features/chat/chat-sync.js";

test("real chat WebSocket publishes a new rollout answer while the API stays stale", async (t) => {
  const x = await fixture(t);
  await x.write([
    event("indexed", "task_started"),
    item("indexed", "old", "before reload"),
  ]);
  const f = await applicationFixture(t);
  const session = {
    ...x.session,
    id: "live-tail",
    accountId: "fixture",
    status: "running",
  };
  f.application.sessions.get = async () => session;
  f.application.accounts.environment = () => ({ HOME: x.root, CODEX_HOME: x.root });
  f.application.bindings.resolve = async () => ({ id: "thread" });
  f.application.history.readPage = (...args) => readHistoryPage(x.history, ...args);
  f.application.chat.initialize(session, "thread");
  let current;
  const errors = [];
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/sessions/${session.id}/chat-stream`,
    { origin: f.url, headers: { cookie: f.cookie } },
  );
  ws.on("error", (error) => errors.push(error));
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "sync") current = applyChatSync(current, frame.data);
  });
  t.after(() => ws.terminate());
  const until = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.deepEqual(errors, []);
      assert.ok(Date.now() < deadline, "expected chat update");
      await delay(10);
    }
  };
  await until(() => current?.messages?.some((m) => m.id === "old"));
  await fs.appendFile(
    x.file,
    [
      event("resumed", "task_started"),
      item("resumed", "answer", "new final answer"),
      event("resumed", "task_complete"),
    ]
      .map((record) => JSON.stringify(record) + "\n")
      .join(""),
  );
  f.application.chatEvents.publish(session.id, "source-changed");
  await until(() => current?.messages?.some((m) => m.id === "answer"));
  assert.equal(current.messages.at(-1).text, "new final answer");
});

test("missing anchor cannot append older turns after the latest API history", async (t) => {
  const x = await fixture(t);
  await x.write([
    event("ancient", "task_started"),
    item("ancient", "ancient-answer", "old response"),
  ]);
  const result = await readHistoryPage(x.history, x.session, "thread");
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["old"],
  );
  assert.equal(result.observability.stale, true);
  assert.deepEqual(result.next, { cursor: "older" });
});

for (const failure of ["missing", "oversized", "replaced"])
  test(`a ${failure} supplemental source preserves the API page`, async (t) => {
    const x = await fixture(t);
    await x.write([event("indexed", "task_started")]);
    if (failure === "missing") await fs.unlink(x.file);
    else
      t.mock.method(JsonlHistoryReader, "open", async () => {
        throw Object.assign(Error("fixture"), {
          status: failure === "oversized" ? 413 : 409,
        });
      });
    const result = await readHistoryPage(x.history, x.session, "thread");
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ["old"],
    );
    assert.equal(result.observability.stale, true);
  });

const event = (turn, type, extra = {}) => ({
  type: "event_msg",
  payload: { type, turn_id: turn, ...extra },
});
const item = (turn, id, text) =>
  event(turn, "item_completed", {
    item: {
      type: "AgentMessage",
      id,
      content: [{ type: "Text", text }],
      phase: "final_answer",
    },
  });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-live-tail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  const session = { tool: "codex", cwd: root };
  const history = {
    environment: () => ({ CODEX_HOME: root }),
    codexRolloutIdentity: ProviderHistory.prototype.codexRolloutIdentity,
  };
  history.codexRequest = async (_session, run) =>
    run({
      request: async (method) =>
        method === "thread/read"
          ? {
              thread: { id: "thread", cwd: root, path: file },
            }
          : {
              data: [
                {
                  id: "indexed",
                  status: "interrupted",
                  items: [{ id: "old", type: "agentMessage", text: "before reload" }],
                },
              ],
              nextCursor: "older",
            },
    });
  const write = (records) =>
    fs.writeFile(
      file,
      [{ type: "session_meta", payload: { id: "thread", cwd: root } }, ...records]
        .map((r) => JSON.stringify(r) + "\n")
        .join(""),
    );
  return { root, file, session, history, write };
}

test("resumed answers in the rollout extend a stale paginated API and retain canonical IDs", async (t) => {
  const x = await fixture(t);
  await x.write([
    event("indexed", "task_started"),
    item("indexed", "old", "before reload"),
    event("indexed", "turn_aborted"),
    event("resumed", "task_started"),
    event("resumed", "item_completed", {
      item: {
        type: "UserMessage",
        id: "user",
        content: [{ type: "text", text: "hello" }],
      },
    }),
    event("resumed", "item_completed", {
      item: {
        type: "CommandExecution",
        id: "command",
        command: ["echo", "hello"],
        aggregated_output: "hello",
        status: "Completed",
        exit_code: 0,
      },
    }),
    item("resumed", "answer", "latest answer"),
    event("resumed", "task_complete"),
  ]);
  const result = await readHistoryPage(x.history, x.session, "thread");
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["old", "user", "command", "answer"],
  );
  assert.equal(result.messages.at(-1).text, "latest answer");
  assert.equal(result.messages[2].status, "completed");
  assert.deepEqual(result.next, { cursor: "older" });
});

test("tail reads stop at the indexed turn and ignore incomplete final JSON", async (t) => {
  const x = await fixture(t);
  await x.write([
    { type: "padding", payload: "x".repeat(2 * 1024 * 1024) },
    event("indexed", "task_started"),
    item("indexed", "old", "updated answer"),
    event("indexed", "task_complete"),
  ]);
  await fs.appendFile(x.file, '{"type":"event_msg"');
  let bytes = 0;
  const original = JsonlHistoryReader.prototype.bytes;
  t.mock.method(JsonlHistoryReader.prototype, "bytes", async function (...args) {
    bytes += args[1];
    return original.apply(this, args);
  });
  const result = await readHistoryPage(x.history, x.session, "thread");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, "updated answer");
  assert.ok(bytes < 160000, `read ${bytes} bytes`);
});

test("supplemental messages paginate without losing the API continuation", async (t) => {
  const x = await fixture(t);
  await x.write([
    event("indexed", "task_started"),
    item("indexed", "old", "before reload"),
    event("next", "task_started"),
    ...Array.from({ length: 80 }, (_, i) => item("next", `new-${i}`, `answer ${i}`)),
  ]);
  const first = await readHistoryPage(x.history, x.session, "thread");
  const older = await readHistoryPage(x.history, x.session, "thread", first.next);
  assert.equal(first.messages.length, 50);
  assert.equal(older.messages.length, 31);
  assert.equal(new Set([...older.messages, ...first.messages].map((m) => m.id)).size, 81);
  assert.deepEqual(older.next, { cursor: "older" });
});

test("API catch-up does not duplicate items and foreign-thread events never appear", async (t) => {
  const x = await fixture(t);
  await x.write([
    event("indexed", "task_started"),
    item("indexed", "old", "before reload"),
    event("next", "task_started"),
    item("next", "answer", "latest answer"),
    event("next", "task_complete"),
    {
      ...item("foreign", "private", "must not appear"),
      payload: {
        ...item("foreign", "private", "must not appear").payload,
        thread_id: "other-thread",
      },
    },
  ]);
  const before = await readHistoryPage(x.history, x.session, "thread");
  x.history.codexRequest = async (_session, run) =>
    run({
      request: async (method) =>
        method === "thread/read"
          ? {
              thread: { id: "thread", cwd: x.root, path: x.file },
            }
          : {
              data: [
                {
                  id: "next",
                  status: "completed",
                  items: [{ id: "answer", type: "agentMessage", text: "latest answer" }],
                },
                {
                  id: "indexed",
                  status: "completed",
                  items: [{ id: "old", type: "agentMessage", text: "before reload" }],
                },
              ],
              nextCursor: "older",
            },
    });
  const after = await readHistoryPage(x.history, x.session, "thread");
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(
    after.messages.map((m) => m.id),
    ["old", "answer"],
  );
});
