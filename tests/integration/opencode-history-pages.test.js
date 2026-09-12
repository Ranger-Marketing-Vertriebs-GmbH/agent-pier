import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readOpenCodePage } from "../../server/features/chat/opencode-history-page.js";

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
  const session = { id: "local", tool: "opencode", accountId: "one", cwd: home };
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

test("OpenCode SQLite pages all 1105 native messages without export or database writes", async (t) => {
  const { history, session, message, file, root } = fixture(t);
  for (let i = 0; i < 1105; i++) message(i);
  const before = fs.readFileSync(file);
  const names = fs.readdirSync(path.join(root, "opencode"));
  let page = await readOpenCodePage(history, session, "ses_test");
  assert.equal(page.messages.length, 50);
  let all = page.messages;
  while (page.next) {
    page = await readOpenCodePage(history, session, "ses_test", page.next);
    assert.ok(page.messages.length <= 50);
    all = [...page.messages, ...all];
  }
  assert.deepEqual(
    all.map((m) => m.text),
    Array.from({ length: 1105 }, (_, i) => `${i}:0`),
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.join(root, "opencode")), names);
});

test("oversized multipart message uses native part boundary and preserves latest todos and usage", async (t) => {
  const { history, session, message, db } = fixture(t);
  message(1, 121);
  db.prepare("INSERT INTO todo VALUES (?, ?, ?, ?, ?)").run(
    "ses_test",
    "Build",
    "in_progress",
    "high",
    0,
  );
  let page = await readOpenCodePage(history, session, "ses_test");
  assert.equal(page.messages.length, 50);
  assert.equal(page.tasks[0].text, "Build");
  assert.equal(page.observability.context.usedTokens, 45);
  assert.ok(JSON.stringify(page.next).length < 1500);
  let all = page.messages;
  while (page.next) {
    page = await readOpenCodePage(history, session, "ses_test", page.next);
    all = [...page.messages, ...all];
  }
  assert.deepEqual(
    all.map((m) => m.text),
    Array.from({ length: 121 }, (_, i) => `1:${i}`),
  );
});

test("OpenCode keysets survive append but reject clear, account switches and project mismatch", async (t) => {
  const { history, session, message, db } = fixture(t);
  for (let i = 0; i < 60; i++) message(i);
  const first = await readOpenCodePage(history, session, "ses_test");
  message(60);
  const older = await readOpenCodePage(history, session, "ses_test", first.next);
  assert.equal(older.messages.length, 10);
  await assert.rejects(
    readOpenCodePage(history, { ...session, accountId: "other" }, "ses_test", first.next),
    { status: 409 },
  );
  await assert.rejects(
    readOpenCodePage(history, { ...session, cwd: "/other" }, "ses_test"),
    { status: 409 },
  );
  db.exec("DELETE FROM part; DELETE FROM message");
  await assert.rejects(readOpenCodePage(history, session, "ses_test", first.next), {
    status: 409,
  });
});

test("absent databases remain absent and symlinked databases cannot cross profiles", async (t) => {
  const { history, session, root, home } = fixture(t);
  const missing = {
    ...history,
    environment: () => ({ HOME: home, XDG_DATA_HOME: path.join(home, "missing") }),
  };
  assert.equal(await readOpenCodePage(missing, session, "ses_test"), null);
  assert.equal(fs.existsSync(path.join(home, "missing")), false);
  const linked = path.join(home, "linked");
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(root, "opencode"), path.join(linked, "opencode"));
  await assert.rejects(
    readOpenCodePage(
      { ...history, environment: () => ({ HOME: home, XDG_DATA_HOME: linked }) },
      session,
      "ses_test",
    ),
    { status: 409 },
  );
});

test("hidden parts remain bounded and can be paged through without dropping visible content", async (t) => {
  const { history, session, message, db } = fixture(t);
  const native = message(1, 302);
  db.prepare("UPDATE part SET data=? WHERE message_id=? AND id<>?").run(
    JSON.stringify({ type: "reasoning", text: "internal" }),
    native,
    `${native}_p000000`,
  );
  const first = await readOpenCodePage(history, session, "ses_test");
  assert.deepEqual(first.messages, []);
  assert.ok(first.next);
  const older = await readOpenCodePage(history, session, "ses_test", first.next);
  assert.deepEqual(
    older.messages.map((m) => m.text),
    ["1:0"],
  );
  assert.equal(older.next, null);
});

test("native page does not hydrate old malformed messages or foreign session parts", async (t) => {
  const { history, session, message, db } = fixture(t);
  for (let i = 0; i < 100; i++) message(i);
  db.prepare("UPDATE message SET data=? WHERE id=?").run("not-json", "msg_000000");
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
    "foreign-part",
    "foreign-session",
    "msg_000099",
    JSON.stringify({ type: "text", text: "foreign secret" }),
  );
  const first = await readOpenCodePage(history, session, "ses_test");
  assert.equal(first.messages.length, 50);
  assert.equal(JSON.stringify(first).includes("foreign secret"), false);
});

test("native session revert and deleted boundary parts invalidate cursors", async (t) => {
  const { history, session, message, db } = fixture(t);
  message(1, 100);
  let first = await readOpenCodePage(history, session, "ses_test");
  db.prepare("UPDATE session SET revert=? WHERE id=?").run(
    JSON.stringify({ messageID: "msg_000001" }),
    "ses_test",
  );
  await assert.rejects(readOpenCodePage(history, session, "ses_test", first.next), {
    status: 409,
  });
  first = await readOpenCodePage(history, session, "ses_test");
  db.prepare("DELETE FROM part WHERE id=?").run(first.next.opencode.before.part);
  await assert.rejects(readOpenCodePage(history, session, "ses_test", first.next), {
    status: 409,
  });
});

test("WAL-backed native pages see committed rows without modifying database or WAL", async (t) => {
  const { history, session, message, db, file } = fixture(t);
  db.exec("PRAGMA journal_mode=WAL");
  message(1);
  const before = fs.readFileSync(file);
  const wal = fs.readFileSync(file + "-wal");
  const first = await readOpenCodePage(history, session, "ses_test");
  assert.equal(first.messages[0].text, "1:0");
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(file + "-wal"), wal);
});

test("an oversized native JSON record returns 413 without hiding missing history", async (t) => {
  const { history, session, message, db } = fixture(t);
  message(1);
  db.prepare("UPDATE part SET data=?").run(
    JSON.stringify({ type: "text", text: "x".repeat(16 * 1024 * 1024) }),
  );
  await assert.rejects(readOpenCodePage(history, session, "ses_test"), { status: 413 });
});

test("checkpointed WAL databases are read without creating WAL or SHM files", async (t) => {
  const { history, session, message, db, file } = fixture(t);
  db.exec("PRAGMA journal_mode=WAL");
  message(1);
  db.close();
  db.close = () => {};
  const before = fs.readFileSync(file);
  const first = await readOpenCodePage(history, session, "ses_test");
  assert.equal(first.messages[0].text, "1:0");
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(file + "-wal"), false);
  assert.equal(fs.existsSync(file + "-shm"), false);
});

test("a concurrent writer invalidates an unlocked no-sidecar snapshot", async (t) => {
  const { history, session, message } = fixture(t);
  message(1);
  const environment = history.environment;
  let calls = 0;
  history.environment = () => {
    if (++calls === 2) message(2);
    return environment();
  };
  await assert.rejects(readOpenCodePage(history, session, "ses_test"), { status: 409 });
});

test("V2-only sessions fail explicitly instead of reporting an empty V1 transcript", async (t) => {
  const { history, session, db } = fixture(t);
  db.exec(
    "CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT); INSERT INTO session_message VALUES ('v2','ses_test')",
  );
  await assert.rejects(readOpenCodePage(history, session, "ses_test"), { status: 409 });
});

test("OpenCode edit metadata survives SQLite pagination and completed state refresh", async (t) => {
  const { history, session, message, db } = fixture(t);
  const id = message(1);
  const part = {
    type: "tool",
    tool: "edit",
    state: {
      status: "running",
      input: { filePath: "x.ts", oldString: "const a = 1;", newString: "const a = 2;" },
    },
  };
  const save = () =>
    db.prepare("UPDATE part SET data=? WHERE message_id=?").run(JSON.stringify(part), id);
  save();
  for (let i = 2; i < 65; i++) message(i);
  let page = await readOpenCodePage(history, session, "ses_test");
  while (page.next)
    page = await readOpenCodePage(history, session, "ses_test", page.next);
  const pending = page.messages.find((m) => m.toolName === "edit");
  assert.equal(pending.fileChanges[0].provenance, "excerpt");
  part.state.status = "completed";
  part.state.metadata = { diff: "@@ -12 +12 @@\n-const a = 1;\n+const a = 2;\n" };
  save();
  page = await readOpenCodePage(history, session, "ses_test");
  while (page.next)
    page = await readOpenCodePage(history, session, "ses_test", page.next);
  const completed = page.messages.find((m) => m.id === pending.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.fileChanges[0].rows[1].oldLine, 12);
});
