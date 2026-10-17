import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { writeArchive } from "../../server/features/operations/archive-v2.js";
import { encryptCredentials } from "../../server/features/operations/archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";
import {
  SEAL_MEMBER,
  SEAL_VERSION,
  sealHistory,
} from "../../server/features/operations/history-seal.js";
import { Restore } from "../../server/features/operations/restore.js";

// Seal record version 1 (AgentPier 2.0 to 2.2) sealed only CLI histories and kept
// AgentPier's own histories public; version 2 seals both.
const passphrase = "seal record fixture passphrase";
const cliHistory = "profiles/a/codex/sessions/0.jsonl";
const ownPublic = { "sessions/s1.json": '{"id":"s1","status":"running"}' };

function setup(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-seal-version-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, "live");
  fs.mkdirSync(live);
  return { root, restore: new Restore({ dataDir: live }) };
}

/** A backup sealing `sealed` paths under a record of `version`, with `publicFiles`. */
async function archive(root, name, { version, sealed, publicFiles = {} }) {
  const sources = sealed.map((item, index) => {
    const file = path.join(root, `${name}-${index}.src`);
    fs.writeFileSync(file, "{}\n");
    return { path: item, file, size: 3 };
  });
  const history = sealHistory("backup-id", sources);
  const record = JSON.parse(Buffer.from(history.record.content, "base64"));
  const file = path.join(root, `${name}.apbackup`);
  await writeArchive(file, {
    manifest: {
      createdAt: "2026-10-17T10:00:00.000Z",
      applicationVersion: "2.2.0",
      includeHistory: true,
      withCredentials: true,
      consistency: "per-component-snapshots; independent-native-captures",
      omissions: [],
      captures: [],
    },
    capsule: await encryptCredentials(
      [fileMember(SEAL_MEMBER, { ...record, version })],
      passphrase,
    ),
    members: [
      { path: "accounts.json", bytes: Buffer.from("[]") },
      ...Object.entries(publicFiles).map(([member, content]) => ({
        path: member,
        bytes: Buffer.from(content),
      })),
      ...history.members,
    ],
  });
  return file;
}

test("new backups write seal record version 2", () => {
  const { record } = sealHistory("id", []);
  assert.equal(SEAL_VERSION, 2);
  assert.equal(JSON.parse(Buffer.from(record.content, "base64")).version, 2);
});

test("a version 1 seal record restores with public AgentPier history beside it", async (t) => {
  const { root, restore } = setup(t);
  const file = await archive(root, "legacy", {
    version: 1,
    sealed: [cliHistory],
    publicFiles: ownPublic,
  });
  const target = path.join(root, "target-legacy");
  const report = await restore.apply({
    archive: file,
    targetDataDir: target,
    passphrase,
  });
  assert.equal(report.importedSessions, 1);
  assert.equal(fs.readFileSync(path.join(target, cliHistory), "utf8"), "{}\n");
});

test("a version 1 seal record cannot seal AgentPier's own history", async (t) => {
  const { root, restore } = setup(t);
  const file = await archive(root, "v1-own", {
    version: 1,
    sealed: ["sessions/s1.screen"],
  });
  const target = path.join(root, "target-v1-own");
  await assert.rejects(
    restore.apply({ archive: file, targetDataDir: target, passphrase }),
    {
      message: serverMessages.backups.historyAuthenticationFailed,
    },
  );
  assert.equal(fs.existsSync(target), false);
});

test("beside a version 2 seal record, public AgentPier history is refused", async (t) => {
  const { root, restore } = setup(t);
  for (const [name, member] of [
    ["session", "sessions/s1.json"],
    ["chat", "chat/s1.snapshot.json"],
    ["agentbus", `imported-history/agentbus/${"a".repeat(64)}/inbox/m.json`],
  ]) {
    const file = await archive(root, name, {
      version: 2,
      sealed: [cliHistory, "sessions/s2.screen"],
      publicFiles: { [member]: "{}" },
    });
    const target = path.join(root, `target-${name}`);
    await assert.rejects(
      restore.apply({ archive: file, targetDataDir: target, passphrase }),
      { message: serverMessages.backups.unexpectedComponent },
      name,
    );
    assert.equal(fs.existsSync(target), false, name);
  }
  // Without the public member the same archive restores.
  const file = await archive(root, "clean", {
    version: 2,
    sealed: [cliHistory, "sessions/s2.screen"],
  });
  const target = path.join(root, "target-clean");
  await restore.apply({ archive: file, targetDataDir: target, passphrase });
  assert.equal(fs.readFileSync(path.join(target, "sessions/s2.screen"), "utf8"), "{}\n");
});

test("an unknown seal record version is refused as unsupported", async (t) => {
  const { root, restore } = setup(t);
  const file = await archive(root, "future", { version: 3, sealed: [cliHistory] });
  await assert.rejects(
    restore.apply({
      archive: file,
      targetDataDir: path.join(root, "target-future"),
      passphrase,
    }),
    { message: serverMessages.backups.unsupportedHistorySeal },
  );
});
