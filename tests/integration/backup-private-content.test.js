import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { readArchiveHeader } from "../../server/features/operations/archive-v2.js";
import { privateContentOmissions } from "../../server/features/operations/private-content.js";
import { RunStore } from "../../server/features/pipelines/run-store.js";
import { archiveText } from "../helpers/backup-archive.js";
import {
  artifactIds,
  botToken,
  generations,
  marker,
  passphrase,
  privateContentFixture,
  rows,
} from "../helpers/private-content-fixture.js";

const privateFiles = [
  "assistants/workspaces/home/MEMORY.md",
  "assistants/workspaces/home/attachments/photo.png",
  "assistants/shares/home/20261017-101500-1a2b3c4d-report.pdf",
  "assistants/state/agents/home/sessions/s1.jsonl",
  "assistants/state/media/inbound/voice.ogg",
  "assistants/state/state/openclaw.sqlite",
  "pipeline-runs/runs.sqlite",
  `artifacts/generations/${generations.unpinned}/0`,
];
const index = (target) =>
  JSON.parse(fs.readFileSync(path.join(target, "artifacts/index.json"), "utf8"));

test("without a passphrase, private content is left out and agents keep their settings", async (t) => {
  const { root, dataDir } = privateContentFixture(t);
  const backup = new Backup({ dataDir });
  const plan = backup.plan({ includeHistory: true });
  for (const component of ["pipeline-history", "unpinned-artifacts", "agent-history"])
    assert.equal(plan.components.includes(component), false, component);
  assert.ok(plan.omissions.includes(privateContentOmissions.unsealed));
  assert.ok(
    backup
      .plan({ includeHistory: false })
      .omissions.includes(privateContentOmissions.history),
  );
  const made = await backup.create({ includeHistory: true });
  // No chat, channel message, workspace file, transcript, run or unpinned artifact
  // byte in any member, the header or the manifest.
  assert.equal(archiveText(made.file).includes(marker), false);
  const header = await readArchiveHeader(made.file);
  const names = header.members.map((member) => member.path);
  for (const name of privateFiles) assert.equal(names.includes(name), false, name);
  assert.equal(
    header.members.some((member) => member.kind === "sealed"),
    false,
  );
  assert.ok(made.manifest.omissions.includes(privateContentOmissions.unsealed));

  const target = path.join(root, "restored");
  const report = await new Restore({ dataDir }).apply({
    archive: made.file,
    targetDataDir: target,
  });
  assert.ok(report.omissions.includes(privateContentOmissions.unsealed));
  assert.equal(report.importedRuns, 0);
  const agents = path.join(target, "assistants");
  // Agent configuration comes back; its conversations and channel messages do not.
  assert.deepEqual(
    rows(path.join(agents, "assistants.sqlite"), "SELECT id FROM assistants"),
    [{ id: "home" }],
  );
  for (const table of ["conversations", "messages"])
    assert.deepEqual(
      rows(path.join(agents, "assistants.sqlite"), `SELECT * FROM ${table}`),
      [],
    );
  assert.deepEqual(
    rows(path.join(agents, "channels.sqlite"), "SELECT name FROM channels"),
    [{ name: "Family chat" }],
  );
  assert.deepEqual(
    rows(path.join(agents, "channels.sqlite"), "SELECT * FROM channel_inbox"),
    [],
  );
  assert.ok(fs.existsSync(path.join(agents, "state/openclaw.json")));
  for (const name of privateFiles)
    assert.equal(fs.existsSync(path.join(target, name)), false, name);
  // The pinned artifact stays; the unpinned one is a tombstone without its receipt.
  const restored = index(target);
  assert.equal(restored.records[artifactIds.pinned].pinned, true);
  assert.equal(restored.records[artifactIds.unpinned].deleted, true);
  assert.deepEqual(Object.keys(restored.receipts), ["s1:pinned"]);
  assert.ok(
    fs.existsSync(path.join(target, `artifacts/generations/${generations.pinned}/0`)),
  );
});

test("with a passphrase, private content is sealed and restores intact", async (t) => {
  const { root, dataDir } = privateContentFixture(t);
  const backup = new Backup({ dataDir });
  const plan = backup.plan({ includeHistory: true, withCredentials: true });
  for (const component of ["pipeline-history", "unpinned-artifacts", "agent-history"])
    assert.ok(plan.components.includes(component), component);
  assert.equal(
    plan.omissions.some((item) => Object.values(privateContentOmissions).includes(item)),
    false,
  );
  const made = await backup.create({ withCredentials: true, passphrase });
  assert.equal(archiveText(made.file).includes(marker), false);
  const header = await readArchiveHeader(made.file);
  const names = header.members.map((member) => member.path);
  for (const name of [...privateFiles, "artifacts/unpinned.json"])
    assert.equal(names.includes(name), false, name);
  assert.ok(header.members.filter((member) => member.kind === "sealed").length >= 10);
  // The public manifest names no private file.
  for (const word of ["workspaces/", "shares/", "pipeline-runs", generations.unpinned])
    assert.equal(JSON.stringify(header.manifest).includes(word), false, word);
  // Inspection without the passphrase reads no private content.
  const restore = new Restore({ dataDir });
  assert.equal((await restore.inspect({ archive: made.file })).requiresPassphrase, true);

  const target = path.join(root, "restored");
  const report = await restore.apply({
    archive: made.file,
    targetDataDir: target,
    passphrase,
  });
  for (const name of privateFiles)
    assert.ok(fs.existsSync(path.join(target, name)), name);
  const agents = path.join(target, "assistants");
  assert.equal(
    fs.readFileSync(path.join(agents, "workspaces/home/MEMORY.md"), "utf8"),
    `remember ${marker}`,
  );
  assert.deepEqual(
    rows(path.join(agents, "assistants.sqlite"), "SELECT id FROM assistants"),
    [{ id: "home" }],
  );
  assert.deepEqual(
    rows(path.join(agents, "assistants.sqlite"), "SELECT body FROM messages"),
    [{ body: JSON.stringify([{ text: marker }]) }],
  );
  assert.equal(
    rows(path.join(agents, "channels.sqlite"), "SELECT body FROM channel_inbox")[0].body,
    JSON.stringify({ text: marker }),
  );
  // Credentials still travel only in their sidecar, under this host's key.
  assert.deepEqual(
    rows(path.join(agents, "channels.sqlite"), "SELECT token FROM channel_credentials"),
    [{ token: botToken }],
  );
  const openclaw = path.join(agents, "state/state/openclaw.sqlite");
  assert.deepEqual(rows(openclaw, "SELECT body FROM conversations"), [{ body: marker }]);
  assert.equal(rows(openclaw, "SELECT * FROM auth_profile_store").length, 1);
  assert.equal(report.credentialsNeedingLogin.includes("assistants"), false);
  assert.equal(fs.existsSync(path.join(target, "assistant-history")), false);
  // Pipeline history comes back as history only.
  assert.equal(report.importedRuns, 1);
  const runs = new RunStore(target);
  try {
    const run = runs.get("run");
    assert.equal(run.status, "cancelled");
    assert.equal(run.imported.historyOnly, true);
  } finally {
    runs.close();
  }
  // The unpinned artifact and its receipt are merged back into the index.
  const restored = index(target);
  assert.equal(restored.records[artifactIds.unpinned].pinned, false);
  assert.deepEqual(Object.keys(restored.receipts).sort(), ["s1:pinned", "s1:unpinned"]);
  assert.equal(fs.existsSync(path.join(target, "artifacts/unpinned.json")), false);
  assert.equal(
    fs.readFileSync(
      path.join(target, `artifacts/generations/${generations.unpinned}/0`),
      "utf8",
    ),
    `<h1>${marker}</h1>`,
  );
});

test("a passphrase without history keeps private content out but credentials in", async (t) => {
  const { root, dataDir } = privateContentFixture(t);
  const made = await new Backup({ dataDir }).create({
    includeHistory: false,
    withCredentials: true,
    passphrase,
  });
  assert.equal(archiveText(made.file).includes(marker), false);
  assert.ok(made.manifest.omissions.includes(privateContentOmissions.history));
  const target = path.join(root, "restored");
  const report = await new Restore({ dataDir }).apply({
    archive: made.file,
    targetDataDir: target,
    passphrase,
  });
  const agents = path.join(target, "assistants");
  assert.deepEqual(
    rows(path.join(agents, "channels.sqlite"), "SELECT token FROM channel_credentials"),
    [{ token: botToken }],
  );
  assert.deepEqual(
    rows(path.join(agents, "channels.sqlite"), "SELECT * FROM channel_inbox"),
    [],
  );
  for (const name of privateFiles)
    assert.equal(fs.existsSync(path.join(target, name)), false, name);
  // OpenClaw's state database stayed out with its credential rows: agents sign in.
  assert.ok(report.credentialsNeedingLogin.includes("assistants"));
});
