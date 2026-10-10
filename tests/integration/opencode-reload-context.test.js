import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readOpenCodeReloadContext } from "../../server/features/chat/opencode-history-page.js";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-reload-"));
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
  const session = { id: "local", tool: "opencode", accountId: "one", cwd: home };
  const history = {
    home,
    environment: () => ({ HOME: home, XDG_DATA_HOME: root }),
  };
  let index = 0;
  const message = (info) => {
    const id = `msg_${String(index).padStart(6, "0")}`;
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      id,
      "ses_test",
      index++,
      JSON.stringify(info),
    );
    return id;
  };
  const reply = (modelID, extra = {}) =>
    message({
      role: "assistant",
      time: { created: index, completed: index + 1 },
      modelID,
      tokens: { input: 42, cache: { read: 0, write: 0 } },
      ...extra,
    });
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { db, history, session, message, reply };
}

test("OpenCode reload context reads the latest model without an export", async (t) => {
  const { history, session, message, reply } = fixture(t);
  reply("old-model");
  for (let n = 0; n < 2000; n++) reply("middle-model");
  reply("latest-model");
  reply("failed-model", { error: { name: "APIError" } });
  message({ role: "user", time: { created: 1 } });
  const context = await readOpenCodeReloadContext(history, session, "ses_test");
  assert.equal(context.observability.context.modelId, "latest-model");
});

test("OpenCode reload context ignores reverted replies", async (t) => {
  const { db, history, session, reply } = fixture(t);
  reply("kept-model");
  const reverted = reply("reverted-model");
  db.prepare("UPDATE session SET revert=? WHERE id=?").run(
    JSON.stringify({ messageID: reverted }),
    "ses_test",
  );
  const context = await readOpenCodeReloadContext(history, session, "ses_test");
  assert.equal(context.observability.context.modelId, "kept-model");
});

test("OpenCode reload context keeps verifying the conversation identity", async (t) => {
  const { db, history, session } = fixture(t);
  await assert.rejects(readOpenCodeReloadContext(history, session, "ses_other"), {
    status: 404,
  });
  db.prepare("UPDATE session SET directory=? WHERE id=?").run("/elsewhere", "ses_test");
  await assert.rejects(readOpenCodeReloadContext(history, session, "ses_test"), {
    status: 409,
  });
});
