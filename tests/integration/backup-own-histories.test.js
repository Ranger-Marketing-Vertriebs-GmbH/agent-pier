import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { Backup, historyOmission } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { ImportedHistory } from "../../server/features/operations/imported-history.js";
import { readArchiveHeader } from "../../server/features/operations/archive-v2.js";
import {
  archiveText,
  encodeArchiveV1,
  encodeArchiveV2,
  loadArchive,
} from "../helpers/backup-archive.js";

// AgentPier's own histories: terminal captures, chats and AgentBus messages.
const marker = "own-history-plaintext-marker";
const project = "a".repeat(64);
const histories = {
  "sessions/s1.json": JSON.stringify({ id: "s1", status: "running", title: marker }),
  "sessions/s1.screen": `screen ${marker}\n`,
  "sessions/s1.events.jsonl": `{"text":"${marker}"}\n`,
  "chat/s1.snapshot.json": JSON.stringify({ messages: [marker] }),
  [`imported-history/agentbus/${project}/inbox/m1.json`]: JSON.stringify({
    body: `imported ${marker}`,
  }),
};
const message = "inbox/codex-x/pending/m2.json";
const liveInbox = {
  [`agentbus/projects/${project}/${message}`]: JSON.stringify({
    id: "m2",
    text: `live ${marker}`,
    ts: 1700000000000,
    from: { runtime: "codex", sessionId: "x" },
  }),
};
const passphrase = "own history fixture passphrase";
const ownHistory = /^(sessions|chat|imported-history)\//;

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-own-history-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  for (const [name, content] of Object.entries({
    "accounts.json": "[]",
    ...histories,
    ...liveInbox,
  })) {
    fs.mkdirSync(path.dirname(path.join(dataDir, name)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, name), content);
  }
  return { root, dataDir, backup: new Backup({ dataDir, home: root }) };
}

test("AgentPier's own histories are sealed with the passphrase and restore intact", async (t) => {
  const { root, dataDir, backup } = fixture(t);
  const made = await backup.create({ withCredentials: true, passphrase });
  // No transcript byte in any public member, the header or the manifest.
  assert.equal(archiveText(made.file).includes(marker), false);
  const header = await readArchiveHeader(made.file);
  assert.deepEqual(
    header.members.filter((member) => ownHistory.test(member.path)),
    [],
  );
  assert.equal(
    header.members.filter((member) => member.kind === "sealed").length,
    Object.keys(histories).length + 1,
  );
  // The public manifest does not name the sealed session files either.
  assert.equal(JSON.stringify(header.manifest).includes("sessions/"), false);
  assert.equal(made.manifest.omissions.includes(historyOmission), false);
  assert.equal(made.manifest.includeHistory, true);
  assert.equal(made.backup.includeHistory, true);
  // Inspection without a passphrase still works and reads no history.
  const restore = new Restore({ dataDir });
  const inspected = await restore.inspect({ archive: made.file });
  assert.equal(inspected.requiresPassphrase, true);
  const wrong = path.join(root, "wrong");
  await assert.rejects(
    restore.apply({
      archive: made.file,
      targetDataDir: wrong,
      passphrase: "x".repeat(20),
    }),
    { message: serverMessages.backups.authenticationFailed },
  );
  assert.equal(fs.existsSync(wrong), false);
  const target = path.join(root, "restored");
  const report = await restore.apply({
    archive: made.file,
    targetDataDir: target,
    passphrase,
  });
  assert.equal(report.importedSessions, 1);
  for (const [name, content] of Object.entries(histories))
    if (name !== "sessions/s1.json")
      assert.equal(fs.readFileSync(path.join(target, name), "utf8"), content, name);
  // Live AgentBus inboxes come back as read-only imported history.
  assert.equal(fs.existsSync(path.join(target, "agentbus")), false);
  assert.equal(
    new ImportedHistory(target).messages(project).items[0].text,
    `live ${marker}`,
  );
  const session = JSON.parse(fs.readFileSync(path.join(target, "sessions/s1.json")));
  assert.equal(session.title, marker);
  assert.equal(session.status, "stopped");
});

test("a backup without a passphrase leaves AgentPier's histories out and says so", async (t) => {
  const { dataDir, backup } = fixture(t);
  const plan = backup.plan({ includeHistory: true });
  for (const component of ["chat", "terminal", "agentbus-history", "cli-histories"])
    assert.equal(plan.components.includes(component), false, component);
  assert.ok(plan.omissions.includes(historyOmission));
  const made = await backup.create({ includeHistory: true });
  assert.equal(archiveText(made.file).includes(marker), false);
  const header = await readArchiveHeader(made.file);
  assert.deepEqual(
    header.members.filter(
      (member) => ownHistory.test(member.path) || member.kind === "sealed",
    ),
    [],
  );
  assert.ok(made.manifest.omissions.includes(historyOmission));
  // The backup records the history it holds, not the history asked for.
  assert.equal(made.manifest.includeHistory, false);
  assert.equal(made.backup.includeHistory, false);
  assert.equal(backup.list()[0].includeHistory, false);
  assert.ok(fs.existsSync(path.join(dataDir, "sessions/s1.json")));
});

test("with a passphrase, no history is listed as left out", (t) => {
  const { backup } = fixture(t);
  const plan = backup.plan({ includeHistory: true, withCredentials: true });
  for (const component of ["chat", "terminal", "agentbus-history"])
    assert.ok(plan.components.includes(component), component);
  assert.deepEqual(
    plan.omissions.filter((item) => /histor/i.test(item)),
    [],
  );
  const without = backup.plan({ includeHistory: false, withCredentials: true });
  assert.ok(without.omissions.includes("AgentPier and CLI histories"));
});

test("legacy archives with public AgentPier history still restore", async (t) => {
  const { root, dataDir, backup } = fixture(t);
  const made = await backup.create({ includeHistory: false });
  const archive = loadArchive(made.file);
  archive.manifest = { ...archive.manifest, includeHistory: true };
  for (const [name, content] of Object.entries(histories))
    archive.files.push({
      path: name,
      content: Buffer.from(content).toString("base64"),
      sha256: createHash("sha256").update(content).digest("hex"),
      mode: 0o600,
    });
  const restore = new Restore({ dataDir });
  for (const [version, bytes] of [
    [1, encodeArchiveV1(archive)],
    [2, encodeArchiveV2(archive)],
  ]) {
    const target = path.join(root, `legacy-v${version}`);
    const report = await restore.apply({ archive: bytes, targetDataDir: target });
    assert.equal(report.importedSessions, 1, `v${version}`);
    for (const [name, content] of Object.entries(histories))
      if (name !== "sessions/s1.json")
        assert.equal(fs.readFileSync(path.join(target, name), "utf8"), content, name);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target, "sessions/s1.json"))).title,
      marker,
    );
  }
});
