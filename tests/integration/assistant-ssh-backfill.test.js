import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { commandDigest } from "../../server/features/assistants/agent-ssh-text.js";
import {
  backfillSshCommands,
  sshBackfillMarker,
} from "../../server/features/assistants/ssh-command-backfill.js";

// SSH commands stored before redaction existed are redacted once, in the rows, their
// Telegram texts and the database files (docs/assistant-gateway.md#agent-ssh-access-2026-10-16).
const secret = "Hunter2-s3cr3t";
const command = `mysql -p${secret} -e 'select 1'`;
const redacted = "mysql -p••• -e 'select 1'";

async function legacy(t) {
  const f = await workflowFixture(t);
  const { store } = f.workflows;
  const add = (key, state, payload, extra = {}) =>
    store.reserve({
      assistantId: f.id,
      conversationId: f.channel.conversationId,
      origin: { kind: "owner" },
      key,
      state,
      payload: { action: "ssh", accessId: "host-1", hostName: "db", ...payload },
      ...extra,
    }).id;
  const ids = {
    trusted: add(
      "trusted",
      "completed",
      { trusted: true, commandPreview: command, commandSha256: commandDigest(command) },
      { settled: true },
    ),
    approved: add("approved", "completed", { command }, { settled: true }),
    declined: add("declined", "declined", { command }),
    clean: add("clean", "failed", { command: "uptime" }),
    pending: add("pending", "awaiting_approval", { command }),
    executing: add("executing", "executing", { command }),
  };
  // Earlier revisions leave copies of the text in freed space of the database pages.
  for (const id of Object.values(ids)) store.patch(id, { note: "x".repeat(300) });
  const outbox = f.service.outbox;
  const notice = (id) =>
    outbox.enqueue({
      key: `action-approval:${id}`,
      source: { channelId: f.channel.id, chatId: "42", userId: "42", actionId: id },
      kind: "action-approval",
      text: `Run on db?\n${command}`,
    });
  for (const id of [ids.declined, ids.pending]) notice(id);
  return { f, store, outbox, ids };
}
const marker = (store) =>
  store.db
    .prepare("SELECT 1 FROM assistant_migrations WHERE name=?")
    .get(sshBackfillMarker);
// Records the SQL `store.db` runs through `method` while `operation` runs.
function recording(store, method, operation) {
  const db = store.db,
    sql = [];
  store.db = new Proxy(db, {
    get: (target, property) =>
      property === method
        ? (text, ...rest) => (sql.push(text), target[method](text, ...rest))
        : target[property],
  });
  try {
    return { result: operation(), sql };
  } finally {
    store.db = db;
  }
}
const fileHolds = (dir, name, text) =>
  ["", "-wal"].some((suffix) => {
    const file = path.join(dir, "assistants", name + suffix);
    return fs.existsSync(file) && fs.readFileSync(file).includes(text);
  });

test("settled SSH rows from before redaction are redacted with their digest", async (t) => {
  const { f, store, ids } = await legacy(t);
  const before = Object.fromEntries(
    Object.entries(ids).map(([k, id]) => [k, store.get(id).revision]),
  );
  assert.equal(backfillSshCommands(f.workflows), true);
  for (const kind of ["approved", "declined"]) {
    const a = store.get(ids[kind]);
    assert.equal(a.payload.command, redacted);
    assert.equal(a.payload.commandRedacted, true);
    assert.equal(a.payload.commandSha256, commandDigest(command));
    assert.equal(a.revision, before[kind] + 1);
  }
  const trusted = store.get(ids.trusted);
  assert.equal(trusted.payload.commandPreview, redacted);
  assert.equal(trusted.payload.commandRedacted, true);
  assert.equal(trusted.payload.commandSha256, commandDigest(command));
  assert.equal(trusted.payload.command, undefined);
  // A command without secrets keeps its text and only gains the digest.
  const clean = store.get(ids.clean);
  assert.equal(clean.payload.command, "uptime");
  assert.equal(clean.payload.commandRedacted, undefined);
  assert.equal(clean.payload.commandSha256, commandDigest("uptime"));
  // Rows that may still run keep the exact command until they settle.
  for (const kind of ["pending", "executing"]) {
    const a = store.get(ids[kind]);
    assert.equal(a.payload.command, command);
    assert.equal(a.revision, before[kind]);
  }
  assert.ok(marker(store));
});

test("Telegram texts of settled rows are rewritten, pending ones kept", async (t) => {
  const { f, outbox, ids } = await legacy(t);
  backfillSshCommands(f.workflows);
  const entry = (id) => outbox.all().find((e) => e.key === `action-approval:${id}`);
  const declined = entry(ids.declined);
  assert.equal(JSON.stringify(declined).includes(secret), false);
  assert.match(declined.text, /mysql -p•••/);
  assert.ok(declined.parts.length > 0);
  assert.equal(entry(ids.pending).text.includes(secret), true);
});

test("no freed page or log keeps the old text of a redacted row", async (t) => {
  const { f, store, outbox, ids } = await legacy(t);
  // Only the rows that may still run hold the secret afterwards; drop them first so
  // any copy left in the files must come from a redacted row.
  store.db
    .prepare("DELETE FROM assistant_actions WHERE id IN (?,?)")
    .run(ids.pending, ids.executing);
  outbox.db
    .prepare("DELETE FROM channel_outbox WHERE json_extract(body,'$.source.actionId')=?")
    .run(ids.pending);
  for (const db of [store.db, outbox.db])
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  assert.equal(fileHolds(f.dataDir, "assistants.sqlite", secret), true);
  assert.equal(fileHolds(f.dataDir, "channels.sqlite", secret), true);
  const secureDelete = store.db.prepare("PRAGMA secure_delete").get().secure_delete;
  const { sql: pragmas } = recording(store, "exec", () =>
    backfillSshCommands(f.workflows),
  );
  assert.ok(
    pragmas.indexOf("PRAGMA secure_delete=ON") < pragmas.indexOf("BEGIN IMMEDIATE"),
  );
  assert.ok(pragmas.includes("VACUUM"));
  assert.equal(fileHolds(f.dataDir, "assistants.sqlite", secret), false);
  assert.equal(fileHolds(f.dataDir, "channels.sqlite", secret), false);
  assert.equal(
    store.db.prepare("PRAGMA secure_delete").get().secure_delete,
    secureDelete,
  );
});

test("the marker skips later starts and a rerun changes nothing", async (t) => {
  const { f, store, ids } = await legacy(t);
  backfillSshCommands(f.workflows);
  const revisions = () => Object.values(ids).map((id) => store.get(id).revision);
  const after = revisions();
  const { result, sql: scans } = recording(store, "prepare", () =>
    backfillSshCommands(f.workflows),
  );
  assert.equal(result, false);
  assert.equal(
    scans.some((sql) => sql.includes("assistant_actions")),
    false,
  );
  store.db.prepare("DELETE FROM assistant_migrations").run();
  assert.equal(backfillSshCommands(f.workflows), true);
  assert.deepEqual(revisions(), after);
  assert.ok(marker(store));
});

test("a failed run sets no marker and the next start finishes it", async (t) => {
  const { f, store, outbox, ids } = await legacy(t);
  const rewrite = outbox.rewriteActions;
  outbox.rewriteActions = () => {
    throw Object.assign(Error(`boom ${secret}`), { code: "SQLITE_BUSY" });
  };
  const logged = [];
  t.mock.method(console, "error", (line) => logged.push(line));
  assert.equal(backfillSshCommands(f.workflows), true);
  assert.equal(marker(store), undefined);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].includes(secret), false);
  outbox.rewriteActions = rewrite;
  backfillSshCommands(f.workflows);
  assert.ok(marker(store));
  const entry = outbox.all().find((e) => e.key === `action-approval:${ids.declined}`);
  assert.equal(entry.text.includes(secret), false);
});

test("the workflows start runs the backfill before the first tick", async (t) => {
  const { f, store, ids } = await legacy(t);
  f.workflows.start();
  assert.equal(store.get(ids.approved).payload.command, redacted);
  assert.ok(marker(store));
});

test("a row with its command gets the preview of the redacted command", async (t) => {
  const { f, store } = await legacy(t);
  // The preview cuts the token short of the length that marks it as one; only the
  // whole command shows it.
  const token = `ghp_${"Q7".repeat(15)}`;
  const long = `${"echo ".repeat(14)}${token}`;
  const id = store.reserve({
    assistantId: f.id,
    conversationId: f.channel.conversationId,
    origin: { kind: "owner" },
    key: "cut",
    state: "completed",
    payload: {
      action: "ssh",
      trusted: true,
      command: long,
      commandPreview: `${long.slice(0, 79)}…`,
      commandSha256: commandDigest(long),
    },
  }).id;
  backfillSshCommands(f.workflows);
  const { payload } = store.get(id);
  assert.equal(payload.command, `${"echo ".repeat(14)}•••`);
  assert.equal(payload.commandPreview, payload.command);
  assert.equal(payload.commandRedacted, true);
});

test("without the channel outbox no marker is set", async (t) => {
  const { f, store, ids } = await legacy(t);
  const channels = f.workflows.s.assistantChannels;
  f.workflows.s.assistantChannels = undefined;
  try {
    assert.equal(backfillSshCommands(f.workflows), true);
  } finally {
    f.workflows.s.assistantChannels = channels;
  }
  assert.equal(store.get(ids.approved).payload.command, redacted);
  assert.equal(marker(store), undefined);
  backfillSshCommands(f.workflows);
  assert.ok(marker(store));
});

test("a failed VACUUM is logged by its code and sets no marker", async (t) => {
  const { f, store } = await legacy(t);
  const logged = [];
  t.mock.method(console, "error", (line) => logged.push(line));
  const db = store.db;
  store.db = new Proxy(db, {
    get: (target, property) =>
      property === "exec"
        ? (sql) => {
            if (sql === "VACUUM")
              throw Object.assign(Error(secret), { code: "SQLITE_BUSY" });
            return target.exec(sql);
          }
        : target[property],
  });
  let result;
  try {
    result = backfillSshCommands(f.workflows);
  } finally {
    store.db = db;
  }
  assert.equal(result, true);
  assert.equal(marker(store), undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /SQLITE_BUSY$/);
  assert.equal(logged[0].includes(secret), false);
});
