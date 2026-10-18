import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { writeAssistantFeature } from "../../server/features/assistants/assistant-feature.js";
import { RunStore } from "../../server/features/pipelines/run-store.js";

// Private content beside the histories (AGENTPIER-110): agent chats, channel
// messages, workspaces and attachments, pipeline history and unpinned artifacts.
export const marker = "private-content-plaintext-marker";
export const passphrase = "private content fixture phrase";
export const botToken = "private-content-bot-token-123456";
export const loginToken = "private-content-model-login-654321";
export const openClawDatabases = [
  "state/state/openclaw.sqlite",
  "state/agents/home/agent/openclaw-agent.sqlite",
];
export const generations = {
  pinned: "11111111-1111-4111-8111-111111111111",
  unpinned: "22222222-2222-4222-8222-222222222222",
};
export const artifactIds = {
  pinned: "33333333-3333-4333-8333-333333333333",
  unpinned: "44444444-4444-4444-8444-444444444444",
};
const createdAt = "2026-10-17T10:00:00.000Z";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}
function summary(id, pinned, content) {
  return {
    id,
    projectId: "p1",
    sessionId: "s1",
    title: pinned ? "Pinned report" : `Unpinned ${marker}`,
    mediaType: "text/html",
    sizeBytes: Buffer.byteLength(content),
    createdAt,
    updatedAt: createdAt,
    pinned,
  };
}
/** Artifact files and index: one pinned and one unpinned record with a receipt. */
export function artifactIndex() {
  const contents = { pinned: "<h1>pinned</h1>", unpinned: `<h1>${marker}</h1>` };
  const records = {},
    files = {};
  for (const kind of ["pinned", "unpinned"]) {
    const id = artifactIds[kind];
    records[id] = {
      ...summary(id, kind === "pinned", contents[kind]),
      generation: generations[kind],
      entrypoint: "index.html",
      files: [
        {
          path: "index.html",
          mediaType: "text/html",
          size: Buffer.byteLength(contents[kind]),
          stored: "0",
        },
      ],
    };
    files[`artifacts/generations/${generations[kind]}/0`] = contents[kind];
  }
  const receipt = (kind) => ({
    fingerprint: "a".repeat(64),
    result: {
      ...summary(artifactIds[kind], kind === "pinned", contents[kind]),
      orphaned: false,
    },
  });
  const index = {
    version: 1,
    records,
    receipts: { "s1:pinned": receipt("pinned"), "s1:unpinned": receipt("unpinned") },
    retired: [],
  };
  return { index, files, contents };
}

/** A data directory with agents, a Telegram channel, a pipeline run and artifacts. */
export function privateContentFixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-private-content-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const assistants = path.join(dataDir, "assistants");
  write(path.join(dataDir, "accounts.json"), "[]");

  const store = new AssistantStore({ dataDir });
  store.db
    .prepare("INSERT INTO assistants VALUES (?,?,?)")
    .run("home", 1, JSON.stringify({ id: "home", name: "Home" }));
  store.db
    .prepare("INSERT INTO conversations VALUES (?,?,?,?)")
    .run("c1", "home", "agent:home:main", JSON.stringify({ title: marker }));
  store.db
    .prepare("INSERT INTO messages VALUES (?,?)")
    .run("c1", JSON.stringify([{ text: marker }]));
  store.close();
  writeAssistantFeature(dataDir, { enabled: true });
  const channels = new DatabaseSync(path.join(assistants, "channels.sqlite"));
  channels.exec(`CREATE TABLE channels(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE channel_credentials(id TEXT PRIMARY KEY, token TEXT);
    CREATE TABLE channel_inbox(id TEXT PRIMARY KEY, channel_id TEXT, body TEXT);`);
  channels.prepare("INSERT INTO channels VALUES (?,?)").run("telegram", "Family chat");
  channels
    .prepare("INSERT INTO channel_credentials VALUES (?,?)")
    .run("telegram", botToken);
  channels
    .prepare("INSERT INTO channel_inbox VALUES (?,?,?)")
    .run("m1", "telegram", JSON.stringify({ text: marker }));
  channels.close();
  write(path.join(assistants, "settings.json"), JSON.stringify({ enabled: true }));
  write(
    path.join(assistants, "state/openclaw.json"),
    JSON.stringify({
      agents: { defaults: { workspace: path.join(assistants, "workspaces") } },
    }),
  );
  write(path.join(assistants, "workspaces/home/MEMORY.md"), `remember ${marker}`);
  write(path.join(assistants, "workspaces/home/attachments/photo.png"), marker);
  write(path.join(assistants, "shares/home/20261017-101500-1a2b3c4d-report.pdf"), marker);
  write(
    path.join(assistants, "state/agents/home/sessions/s1.jsonl"),
    `{"t":"${marker}"}\n`,
  );
  write(path.join(assistants, "state/media/inbound/voice.ogg"), marker);
  // OpenClaw's databases: a configuration table, a credential table, a private
  // table, a full-text index and a table a later OpenClaw might add.
  for (const relative of openClawDatabases) {
    const file = path.join(assistants, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE auth_profile_store(profile_id TEXT PRIMARY KEY, value_json TEXT);
      CREATE TABLE exec_approvals_config(id TEXT PRIMARY KEY, value_json TEXT);
      CREATE TABLE session_entries(id TEXT PRIMARY KEY, body TEXT);
      CREATE TABLE future_table(id TEXT PRIMARY KEY, body TEXT);
      CREATE VIRTUAL TABLE memory_fts USING fts5(body);`);
    db.prepare("INSERT INTO auth_profile_store VALUES (?,?)").run(
      "openai:me",
      loginToken,
    );
    db.prepare("INSERT INTO exec_approvals_config VALUES (?,?)").run(
      "ls",
      `{"allow":true}`,
    );
    db.prepare("INSERT INTO session_entries VALUES (?,?)").run("c1", marker);
    db.prepare("INSERT INTO future_table VALUES (?,?)").run("f1", marker);
    db.prepare("INSERT INTO memory_fts(body) VALUES (?)").run(`indexed ${marker}`);
    db.close();
  }
  // Runtime-only state and files a later OpenClaw might add.
  write(
    path.join(assistants, "state/state/openclaw-agent.sqlite.generation-lock.sqlite"),
    "x",
  );
  write(path.join(assistants, "state/locks/gateway.lock.json"), "{}");
  write(path.join(assistants, "state/unknown-folder/notes.json"), JSON.stringify(marker));
  write(path.join(assistants, "state/config-journal-fingerprint.key"), marker);
  write(path.join(assistants, "state/plugin-skills/team/SKILL.md"), "# Team skill");
  write(path.join(assistants, "state/agents/home/agent/models.json"), "{}");

  const runs = new RunStore(dataDir);
  runs.create({
    id: "run",
    status: "running",
    phase: "provisioning",
    task: `Task prompt ${marker}`,
    workspace: null,
    nodes: [],
    executionLog: [],
  });
  runs.close();

  const { index, files } = artifactIndex();
  write(path.join(dataDir, "artifacts/index.json"), JSON.stringify(index));
  for (const [name, content] of Object.entries(files))
    write(path.join(dataDir, name), content);
  return { root, dataDir, assistants };
}

/** Rows of `sql` from database `file`. */
export function rows(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
