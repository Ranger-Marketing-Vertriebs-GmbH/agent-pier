import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const { readOpenCodePage } = await import(
  new URL("../../server/features/chat/opencode-history-page.js", import.meta.url)
);

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pages-"));
  const root = path.join(home, "data");
  fs.mkdirSync(path.join(root, "opencode"), { recursive: true });
  const file = path.join(root, "opencode", "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, revert TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
    CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
    CREATE INDEX part_message_id_id_idx ON part(message_id,id);
    CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);
    CREATE INDEX todo_session_idx ON todo(session_id,position);
  `);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, NULL)").run("ses_test", home, 1);
  const session = {
    id: "local",
    tool: "opencode",
    accountId: "one",
    cwd: home,
  };
  const history = {
    home,
    environment: () => ({ HOME: home, XDG_DATA_HOME: root }),
    read: () => {
      throw Error("must not export");
    },
  };
  const message = (index, parts = 1, nativeId = "ses_test") => {
    const id = `msg_${String(index).padStart(6, "0")}`;
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      id,
      nativeId,
      Math.floor(index / 2),
      JSON.stringify({
        role: "assistant",
        time: { created: index, completed: index + 1 },
        modelID: "gpt-5",
        tokens: { input: 42, cache: { read: 3, write: 0 } },
      }),
    );
    for (let n = 0; n < parts; n++)
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
        `${id}_p${String(n).padStart(6, "0")}`,
        nativeId,
        id,
        JSON.stringify({ type: "text", text: `${index}:${n}` }),
      );
    return id;
  };
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, file, root, db, history, session, message };
}

test("fresh read after full native revert hides discarded messages", async (t) => {
  const { history, session, message, db } = fixture(t);
  message(0);
  message(1);
  message(2);
  db.prepare("UPDATE session SET revert=? WHERE id=?").run(
    JSON.stringify({ messageID: "msg_000001" }),
    "ses_test",
  );
  const page = await readOpenCodePage(history, session, "ses_test");

  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["0:0"],
  );
});

test("partial undo and redo preserve only active parts across page boundaries", async (t) => {
  const { history, session, message, db } = fixture(t);
  message(0);
  message(1, 75);
  message(2);
  const set = (value) =>
    db
      .prepare("UPDATE session SET revert=? WHERE id=?")
      .run(value && JSON.stringify(value), "ses_test");
  set({ messageID: "msg_000001", partID: "msg_000001_p000060" });
  const page = await readOpenCodePage(history, session, "ses_test");
  assert.equal(page.messages.length, 50);
  assert.equal(page.messages.at(-1).text, "1:59");
  const older = await readOpenCodePage(history, session, "ses_test", page.next);
  assert.equal(older.messages[0].text, "0:0");
  assert.equal(older.messages.at(-1).text, "1:9");
  set(null);
  await assert.rejects(readOpenCodePage(history, session, "ses_test", page.next), {
    status: 409,
  });
  const redo = await readOpenCodePage(history, session, "ses_test");
  assert.equal(redo.messages.at(-1).text, "2:0");
});

test("legacy exports apply the same undo boundary without mutating redo storage", async () => {
  const { activeOpenCodeExport } =
    await import("../../server/features/chat/opencode-revert.js");
  const exported = {
    info: { revert: { messageID: "b", partID: "p2" } },
    messages: [
      { info: { id: "a" }, parts: [{ id: "p0" }] },
      { info: { id: "b" }, parts: [{ id: "p1" }, { id: "p2" }] },
      { info: { id: "c" }, parts: [{ id: "p3" }] },
    ],
  };
  const result = activeOpenCodeExport(exported);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[1].parts, [{ id: "p1" }]);
  assert.equal(exported.messages.length, 3);
  assert.equal(exported.messages[1].parts.length, 2);
});
