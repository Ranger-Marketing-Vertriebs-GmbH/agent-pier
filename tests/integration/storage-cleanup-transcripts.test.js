import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  deleteTranscripts,
  profileHomes,
  profileTranscripts,
  protectedIds,
} from "../../server/features/system-status/cleanup-transcripts.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-tx-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, { days = 0, bytes = 4096, text } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text ?? Buffer.alloc(bytes, 1));
  const time = new Date(now - days * DAY);
  fs.utimesSync(file, time, time);
  return file;
}
function age(folder, days) {
  const time = new Date(now - days * DAY);
  fs.utimesSync(folder, time, time);
}

function claudeFixture(t) {
  const dataDir = path.join(temporary(t), "data");
  const account = { id: randomUUID(), tool: "claude", kind: "managed" };
  const home = path.join(dataDir, "profiles", account.id, "claude");
  const project = path.join(home, "projects", "-Users-me-project");
  const ids = {
    old: randomUUID(),
    oldWithFolder: randomUUID(),
    recent: randomUUID(),
    listed: randomUUID(),
    bound: randomUUID(),
    running: randomUUID(),
    provider: randomUUID(),
  };
  write(path.join(project, `${ids.old}.jsonl`), { days: 200 });
  write(path.join(project, `${ids.oldWithFolder}.jsonl`), { days: 100 });
  write(path.join(project, ids.oldWithFolder, "subagents", "agent-a.jsonl"), {
    days: 100,
  });
  age(path.join(project, ids.oldWithFolder, "subagents"), 100);
  age(path.join(project, ids.oldWithFolder), 100);
  write(path.join(project, `${ids.recent}.jsonl`), { days: 5 });
  write(path.join(project, `${ids.listed}.jsonl`), { days: 300 });
  write(path.join(project, `${ids.bound}.jsonl`), { days: 300 });
  write(path.join(project, `${ids.running}.jsonl`), { days: 300 });
  write(path.join(home, "history.jsonl"), { days: 400 });
  write(path.join(project, "notes.jsonl"), { days: 400 });
  // A provider choice of the same profile keeps its own Claude home.
  const providerHome = path.join(dataDir, "profiles", account.id, "providers", "zai");
  write(path.join(providerHome, "claude", "projects", "p", `${ids.provider}.jsonl`), {
    days: 400,
  });
  // A stopped but stored session, a chat binding and a running session's receipt.
  write(path.join(dataDir, "sessions", "s1.json"), {
    text: JSON.stringify({
      id: "s1",
      status: "stopped",
      reload: { nativeId: ids.listed },
    }),
  });
  write(path.join(dataDir, "chat", "s2.binding.json"), {
    text: JSON.stringify({ providerSessionId: ids.bound.toUpperCase() }),
  });
  write(path.join(dataDir, "native-sessions", "s3.receipt.json"), {
    text: JSON.stringify({ providerSessionId: ids.running }),
  });
  return { dataDir, account, project, ids, home };
}

test("Claude transcripts: old ones of unknown sessions only, with their folders", async (t) => {
  const { dataDir, account, project, ids, home } = claudeFixture(t);
  const protectedSet = await protectedIds(dataDir);
  for (const key of ["listed", "bound", "running"])
    assert.ok(protectedSet.has(ids[key]), `${key} is protected`);
  assert.equal((await profileHomes(dataDir, account)).length, 2);
  const { cutoffs } = await profileTranscripts(dataDir, account, protectedSet, now);
  assert.deepEqual(
    cutoffs.map(({ days, count, kept }) => ({ days, count, kept })),
    [
      { days: 30, count: 3, kept: 3 },
      { days: 90, count: 3, kept: 3 },
      { days: 180, count: 2, kept: 3 },
    ],
  );
  const result = await deleteTranscripts(dataDir, account, 180, { now });
  assert.equal(result.removed, 2);
  assert.ok(!fs.existsSync(path.join(project, `${ids.old}.jsonl`)));
  assert.ok(fs.existsSync(path.join(project, `${ids.oldWithFolder}.jsonl`)), "younger");
  const second = await deleteTranscripts(dataDir, account, 90, { now });
  assert.equal(second.removed, 1);
  assert.ok(!fs.existsSync(path.join(project, ids.oldWithFolder)), "its folder went");
  for (const key of ["recent", "listed", "bound", "running"])
    assert.ok(fs.existsSync(path.join(project, `${ids[key]}.jsonl`)), `${key} stays`);
  assert.ok(fs.existsSync(path.join(home, "history.jsonl")), "the prompt history stays");
  assert.ok(fs.existsSync(path.join(project, "notes.jsonl")), "other files stay");
});

test("a transcript changed after the listing stays", async (t) => {
  const { dataDir, account, project, ids } = claudeFixture(t);
  const file = path.join(project, `${ids.old}.jsonl`);
  // Changed again by a session resumed meanwhile (mtime newer than the cutoff).
  fs.utimesSync(file, new Date(), new Date());
  const result = await deleteTranscripts(dataDir, account, 180, { now });
  assert.ok(fs.existsSync(file));
  assert.equal(result.removed, 1);
});

test("Codex rollouts go, its thread databases stay untouched", async (t) => {
  const dataDir = path.join(temporary(t), "data");
  const account = { id: randomUUID(), tool: "codex", kind: "managed" };
  const home = path.join(dataDir, "profiles", account.id, "codex");
  const [old, archived, listed, recent, piped] = Array.from({ length: 5 }, () =>
    randomUUID(),
  );
  const rollout = (id, days, folder = "sessions/2026/01/02") =>
    write(path.join(home, folder, `rollout-2026-01-02T10-00-00-${id}.jsonl`), { days });
  const files = {
    old: rollout(old, 120),
    archived: rollout(archived, 200, "archived_sessions"),
    listed: rollout(listed, 300),
    recent: rollout(recent, 10),
    piped: rollout(piped, 300),
  };
  const databases = [
    "state_5.sqlite",
    "thread_history_1.sqlite",
    "thread_history_1.sqlite-wal",
  ];
  for (const name of databases) write(path.join(home, name), { days: 300, text: name });
  write(path.join(dataDir, "chat", "s1.binding.json"), {
    text: JSON.stringify({ providerSessionId: listed }),
  });
  // A pipeline run's step resumes its CLI session by the id it keeps.
  const records = () => [JSON.stringify([{ nodes: { build: { nativeId: piped } } }])];
  const result = await deleteTranscripts(dataDir, account, 90, { now, records });
  assert.equal(result.removed, 2);
  assert.ok(fs.existsSync(files.piped), "a pipeline step's session stays");
  await assert.rejects(
    deleteTranscripts(dataDir, account, 90, {
      now,
      records: () => {
        throw Error("database locked");
      },
    }),
    { status: 503 },
  );
  assert.ok(!fs.existsSync(files.old));
  assert.ok(!fs.existsSync(files.archived));
  assert.ok(fs.existsSync(files.listed));
  assert.ok(fs.existsSync(files.recent));
  for (const name of databases)
    assert.equal(
      fs.readFileSync(path.join(home, name), "utf8"),
      name,
      `${name} unchanged`,
    );
});

test("links are never followed and unreadable records refuse the cleanup", async (t) => {
  const root = temporary(t);
  const dataDir = path.join(root, "data");
  const account = { id: randomUUID(), tool: "claude", kind: "managed" };
  const outside = path.join(root, "outside");
  const victim = write(path.join(outside, `${randomUUID()}.jsonl`), { days: 400 });
  const home = path.join(dataDir, "profiles", account.id, "claude");
  fs.mkdirSync(path.join(home, "projects", "real"), { recursive: true });
  fs.symlinkSync(outside, path.join(home, "projects", "linked"));
  const link = path.join(home, "projects", "real", `${randomUUID()}.jsonl`);
  fs.symlinkSync(victim, link);
  const result = await deleteTranscripts(dataDir, account, 30, { now });
  assert.equal(result.removed, 0);
  assert.ok(fs.existsSync(victim));
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "a linked transcript is no transcript");
  // A profile home that is a link is no home of the profile.
  const linked = { id: randomUUID(), tool: "claude", kind: "managed" };
  fs.mkdirSync(path.join(dataDir, "profiles", linked.id), { recursive: true });
  fs.symlinkSync(outside, path.join(dataDir, "profiles", linked.id, "claude"));
  assert.deepEqual(await profileHomes(dataDir, linked), []);
  const record = write(path.join(dataDir, "sessions", "s1.json"), { text: "{}" });
  fs.chmodSync(record, 0);
  if (process.getuid?.() !== 0)
    await assert.rejects(deleteTranscripts(dataDir, account, 30, { now }), {
      status: 503,
    });
  await assert.rejects(deleteTranscripts(dataDir, account, 7, { now }), { status: 400 });
  await assert.rejects(
    deleteTranscripts(dataDir, { ...account, tool: "opencode" }, 30, { now }),
    { status: 409 },
  );
});
