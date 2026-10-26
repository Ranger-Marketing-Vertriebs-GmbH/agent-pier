import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { deleteNativeSession } from "../../server/features/assistants/chat-removal.js";

// AGENTPIER-234: a deleted chat leaves dreaming by every session id it had. The
// Gateway may no longer know its session (deleted before AgentPier recorded the id,
// or by an earlier attempt), and a reset gave the same key earlier ids; OpenClaw's
// transcript archives name them by key until the deletion purges the archives, so
// they are read first and each is forgotten.
function fixture(t, { describe = null } = {}) {
  const dataDir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "assistant-dreaming-forget-"),
  );
  const paths = runtimePaths(dataDir);
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const created = store.createAssistant({
    name: "Orchid",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  const agent = store.getAssistant(created.id);
  const key = `agent:${agent.runtimeAgentId}:chat`;
  const chat = store.saveConversation({ assistantId: agent.id, runtimeSessionKey: key });
  // The runtime's CLI records each call's arguments.
  const record = path.join(dataDir, "forget-calls.jsonl");
  const entryPath = path.join(dataDir, "openclaw.mjs");
  fs.writeFileSync(
    entryPath,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("{}");`,
  );
  const calls = [];
  const assistants = {
    store,
    admit: (fn) => fn(),
    ledger: { forgetTexts() {} },
    runtime: {
      paths,
      runtime: { nodePath: process.execPath, entryPath },
      client: {
        ready: true,
        async call(method) {
          calls.push(method);
          if (method === "sessions.describe")
            return describe ? { session: { sessionId: describe } } : {};
          return {};
        },
      },
    },
  };
  // OpenClaw's archive table (2026.10.7), trimmed to the columns AgentPier reads.
  function archives(rows) {
    const folder = path.join(paths.state, "agents", agent.runtimeAgentId, "agent");
    fs.mkdirSync(folder, { recursive: true });
    const db = new DatabaseSync(path.join(folder, "openclaw-agent.sqlite"));
    db.exec(
      "CREATE TABLE session_transcript_archives (session_id TEXT NOT NULL, session_key TEXT NOT NULL, archive_name TEXT NOT NULL UNIQUE)",
    );
    const insert = db.prepare("INSERT INTO session_transcript_archives VALUES (?,?,?)");
    for (const [sessionId, sessionKey, reason] of rows)
      insert.run(sessionId, sessionKey, `${sessionId}.jsonl.${reason}.2026-10-25.g1.zst`);
    db.close();
  }
  const forgotten = () =>
    fs.existsSync(record)
      ? fs
          .readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return { assistants, agent, chat, key, calls, archives, forgotten };
}

const forget = (agent, ...sessions) => [
  "memory",
  "forget",
  "--agent",
  agent.runtimeAgentId,
  ...sessions.flatMap((id) => ["--session", id]),
  "--json",
];

test("a chat whose session id was never learned is forgotten by its archived ids", async (t) => {
  const f = fixture(t);
  f.archives([
    ["s-old", f.key, "reset"],
    ["s-last", f.key, "deleted"],
    ["s-other", "agent:other:chat", "deleted"],
  ]);
  assert.equal(await deleteNativeSession(f.assistants, f.chat), true);
  await f.assistants.dreamingForgets;
  assert.deepEqual(f.calls, ["sessions.describe", "sessions.delete"]);
  assert.deepEqual(f.forgotten(), [forget(f.agent, "s-last", "s-old")]);
});

test("a known session id is forgotten with the ids a reset left under its key", async (t) => {
  const f = fixture(t, { describe: "s-live" });
  f.archives([["s-before-reset", f.key, "reset"]]);
  assert.equal(await deleteNativeSession(f.assistants, f.chat), true);
  await f.assistants.dreamingForgets;
  assert.deepEqual(f.forgotten(), [forget(f.agent, "s-live", "s-before-reset")]);
});

test("a chat without any session id left runs no forget", async (t) => {
  const f = fixture(t);
  f.archives([["s-other", "agent:other:chat", "deleted"]]);
  assert.equal(await deleteNativeSession(f.assistants, f.chat), true);
  await f.assistants.dreamingForgets;
  assert.deepEqual(f.forgotten(), []);
});
