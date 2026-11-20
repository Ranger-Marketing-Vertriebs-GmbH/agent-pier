import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readOpenCodePage } from "../../server/features/chat/opencode-history-page.js";
import { normalizeOpenCode } from "../../server/features/chat/history-parsers.js";

// OpenCode stores a provider's refusal on the assistant message (`info.error`), often
// without any part: the chat showed "Accepted by CLI" and then nothing (AGENTPIER-411).
const refusal = {
  name: "APIError",
  data: {
    message: "Incorrect API key provided: sk-…xyz.",
    statusCode: 401,
    isRetryable: false,
  },
};

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-error-"));
  const root = path.join(home, "data");
  fs.mkdirSync(path.join(root, "opencode"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "opencode", "opencode.db"));
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, revert TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
    CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);
  `);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, NULL)").run("ses_test", home, 1);
  const add = (id, time, info, parts = []) => {
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      id,
      "ses_test",
      time,
      JSON.stringify(info),
    );
    parts.forEach((part, index) =>
      db
        .prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
        .run(`${id}_p${index}`, "ses_test", id, JSON.stringify(part)),
    );
  };
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const history = {
    home,
    environment: () => ({ HOME: home, XDG_DATA_HOME: root }),
    read: () => {
      throw Error("must not export");
    },
  };
  const session = { id: "local", tool: "opencode", accountId: "one", cwd: home };
  return { add, read: () => readOpenCodePage(history, session, "ses_test") };
}

test("a provider error on an OpenCode reply shows in the chat as a failed message", async (t) => {
  const { add, read } = fixture(t);
  add("msg_1", 1, { role: "user", time: { created: 1 } }, [{ type: "text", text: "Hi" }]);
  add("msg_2", 2, { role: "assistant", time: { created: 2 }, error: refusal });
  const page = await read();
  assert.deepEqual(
    page.messages.map(({ role, text, status, notice }) => ({
      role,
      text,
      status,
      notice,
    })),
    [
      { role: "user", text: "Hi", status: undefined, notice: undefined },
      {
        role: "assistant",
        text: "Incorrect API key provided: sk-…xyz.",
        status: "failed",
        notice: "provider-error",
      },
    ],
  );
});

test("the error follows the parts of its reply, and a stopped reply stays quiet", async (t) => {
  const { add, read } = fixture(t);
  add("msg_1", 1, { role: "assistant", time: { created: 1 }, error: refusal }, [
    { type: "text", text: "Partial answer" },
  ]);
  add("msg_2", 2, {
    role: "assistant",
    time: { created: 2 },
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  });
  const page = await read();
  assert.deepEqual(
    page.messages.map((message) => message.text),
    ["Partial answer", "Incorrect API key provided: sk-…xyz."],
  );
});

test("the export envelope shows the same error message", () => {
  const { messages } = normalizeOpenCode({
    messages: [{ info: { id: "msg_2", role: "assistant", error: refusal }, parts: [] }],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, "failed");
  assert.equal(messages[0].notice, "provider-error");
});
