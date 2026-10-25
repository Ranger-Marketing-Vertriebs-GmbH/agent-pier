import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { purgeTranscriptArchives } from "../../server/features/assistants/transcript-archives.js";
import { deleteNativeSession } from "../../server/features/assistants/chat-removal.js";

// OpenClaw 2026.10.7's archive table (openclaw-agent-schema), trimmed to what matters.
const schema = `CREATE TABLE session_transcript_archives (
  session_id TEXT NOT NULL, generation TEXT NOT NULL, session_key TEXT NOT NULL,
  reason TEXT NOT NULL, encoding TEXT NOT NULL, archive_blob BLOB NOT NULL,
  archive_name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, published_at INTEGER,
  PRIMARY KEY (session_id, generation)) STRICT;`;

function agentState(t, rows = []) {
  const state = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "archives-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const agent = path.join(state, "agents", "ap-1", "agent");
  const sessions = path.join(state, "agents", "ap-1", "sessions");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(agent, "openclaw-agent.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(schema);
  const insert = db.prepare(
    "INSERT INTO session_transcript_archives VALUES (?,?,?,?,'zstd',?,?,1,1)",
  );
  for (const [sessionId, sessionKey, reason] of rows) {
    const name = `${sessionId}.jsonl.${reason}.2026-10-25T07-00-00.000Z.g1.zst`;
    insert.run(sessionId, "g1", sessionKey, reason, Buffer.from("text"), name);
    fs.writeFileSync(path.join(sessions, name), "text");
  }
  db.close();
  const left = () => {
    const read = new DatabaseSync(file, { readOnly: true });
    try {
      return read
        .prepare("SELECT session_id FROM session_transcript_archives ORDER BY 1")
        .all()
        .map((row) => row.session_id);
    } finally {
      read.close();
    }
  };
  return { state, sessions, file, left, files: () => fs.readdirSync(sessions).sort() };
}

test("purges the archive rows and files of one session and leaves others", (t) => {
  const s = agentState(t, [
    ["s-old", "agent:ap-1:dashboard:a", "reset"],
    ["s-new", "agent:ap-1:dashboard:a", "deleted"],
    ["s-other", "agent:ap-1:dashboard:b", "deleted"],
  ]);
  // A writer holding the database open (as the Gateway does) does not stop it.
  const gateway = new DatabaseSync(s.file);
  t.after(() => gateway.close());
  purgeTranscriptArchives(s.state, "ap-1", {
    sessionKey: "agent:ap-1:dashboard:a",
    sessionId: "s-new",
  });
  assert.deepEqual(s.left(), ["s-other"]);
  assert.deepEqual(s.files(), ["s-other.jsonl.deleted.2026-10-25T07-00-00.000Z.g1.zst"]);
});

test("matches the recorded session id when the key differs", (t) => {
  const s = agentState(t, [["s-1", "agent:ap-1:legacy", "deleted"]]);
  purgeTranscriptArchives(s.state, "ap-1", {
    sessionKey: "agent:ap-1:x",
    sessionId: "s-1",
  });
  assert.deepEqual(s.left(), []);
});

test("an agent without a database or archive table has nothing to purge", (t) => {
  const s = agentState(t);
  const bare = new DatabaseSync(s.file);
  bare.exec("DROP TABLE session_transcript_archives");
  bare.close();
  purgeTranscriptArchives(s.state, "ap-1", { sessionKey: "k", sessionId: null });
  purgeTranscriptArchives(s.state, "ap-missing", { sessionKey: "k", sessionId: null });
});

test("a database another writer holds fails the purge", (t) => {
  const s = agentState(t, [["s-1", "agent:ap-1:dashboard:a", "deleted"]]);
  const holder = new DatabaseSync(s.file);
  t.after(() => holder.close());
  holder.exec("BEGIN IMMEDIATE");
  assert.throws(
    () =>
      purgeTranscriptArchives(s.state, "ap-1", {
        sessionKey: "agent:ap-1:dashboard:a",
        sessionId: "s-1",
        busyMs: 50,
      }),
    /locked/,
  );
  holder.exec("ROLLBACK");
  // Its row stays for the next try.
  assert.deepEqual(s.left(), ["s-1"]);
});

test("a failed purge keeps the chat's delete pending and logs no content", async (t) => {
  const s = agentState(t, [["s-1", "agent:ap-1:dashboard:a", "deleted"]]);
  const elsewhere = path.join(s.state, "elsewhere.sqlite");
  fs.renameSync(s.file, elsewhere);
  fs.symlinkSync(elsewhere, s.file);
  const updates = [];
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const conversation = {
    id: "c-1",
    assistantId: "a-1",
    runtimeSessionKey: "agent:ap-1:dashboard:a",
  };
  const calls = [];
  const assistants = {
    runtime: {
      client: { ready: true, call: async (method) => calls.push(method) },
      paths: { state: s.state },
    },
    store: {
      storedConversation: () => ({ nativeSessionId: "s-1" }),
      getAssistant: () => ({ runtimeAgentId: "ap-1" }),
      updateConversation: (id, fields) => updates.push(fields),
    },
  };
  assert.equal(await deleteNativeSession(assistants, conversation), false);
  assert.deepEqual(calls, ["sessions.delete"]);
  assert.deepEqual(updates, []);
  assert.deepEqual(logged, [["Transcript archive purge failed:", "ARCHIVE_DB_UNSAFE"]]);
});

test("an agent database that is a link is refused", (t) => {
  const s = agentState(t);
  const elsewhere = path.join(s.state, "elsewhere.sqlite");
  fs.renameSync(s.file, elsewhere);
  fs.symlinkSync(elsewhere, s.file);
  assert.throws(
    () => purgeTranscriptArchives(s.state, "ap-1", { sessionKey: "k", sessionId: null }),
    { code: "ARCHIVE_DB_UNSAFE" },
  );
});
