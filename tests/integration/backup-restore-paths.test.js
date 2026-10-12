import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { writeArchive } from "../../server/features/operations/archive-v2.js";
import {
  encodeArchive,
  encryptCredentials,
} from "../../server/features/operations/archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";
import {
  sealHistory,
  SEAL_MEMBER,
} from "../../server/features/operations/history-seal.js";
import {
  profileMemberKind,
  profilePath,
} from "../../server/features/operations/profile-allowlist.js";
import { stagePath } from "../../server/features/operations/stage-path.js";
import { Restore } from "../../server/features/operations/restore.js";

const passphrase = "crafted archive fixture passphrase";
const manifest = {
  createdAt: "2026-10-13T10:00:00.000Z",
  applicationVersion: "1.29.0",
  includeHistory: true,
  withCredentials: true,
  consistency: "per-component-snapshots; independent-native-captures",
  omissions: [],
  captures: [],
};
function setup(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-paths-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, "live");
  fs.mkdirSync(live);
  return { root, restore: new Restore({ dataDir: live }) };
}
const outside = (root) =>
  fs
    .readdirSync(root, { recursive: true })
    .filter((name) => !/^(live|[A-Za-z0-9-]+\.apbackup)(\/|$)/.test(name));

/** A backup whose capsule seals `history` (real paths) with a doctored record. */
async function craftedSeal(root, name, history, doctor = (record) => record) {
  const sources = history.map((item, index) => {
    const file = path.join(root, `${name}-${index}.src`);
    fs.writeFileSync(file, "planted");
    return { path: item, file, size: 7 };
  });
  // sealHistory runs its own checks; the doctored record bypasses them as an
  // attacker's archive would.
  const sealed = sealHistory(
    "backup-id",
    sources.map((s, index) => ({
      ...s,
      path: `profiles/a/codex/sessions/${index}.jsonl`,
    })),
  );
  const record = JSON.parse(Buffer.from(sealed.record.content, "base64"));
  record.members = record.members.map((member, index) => ({
    ...member,
    path: history[index],
  }));
  const members = sealed.members.map((member, index) => ({
    ...member,
    seal: { ...member.seal, path: history[index] },
  }));
  const file = path.join(root, `${name}.apbackup`);
  await writeArchive(file, {
    manifest,
    capsule: await encryptCredentials(
      [fileMember(SEAL_MEMBER, doctor(record))],
      passphrase,
    ),
    members: [{ path: "accounts.json", bytes: Buffer.from("[]") }, ...members],
  });
  return file;
}

test("profile paths with dot segments, empty segments or odd characters are no profile paths", () => {
  for (const name of [
    "profiles/a/claude/projects/../../../../../out/x",
    "profiles/a/claude/projects/./x",
    "profiles/a/claude/projects//x",
    "profiles/a/claude/projects/x/",
    "/profiles/a/claude/projects/x",
    "profiles/a/claude/projects/x\\..\\y",
    "profiles/a/claude/projects/x\0",
    "profiles/a/providers/../claude/projects/x",
  ]) {
    assert.equal(profilePath(name), null, name);
    assert.equal(profileMemberKind(name), null, name);
  }
  assert.equal(profileMemberKind("profiles/a/claude/projects/p/x.jsonl"), "history");
});

test("crafted seal records never write outside the stage", async (t) => {
  const { root, restore } = setup(t);
  const cases = {
    traversal: ["profiles/a/claude/projects/../../../../../out/escaped.txt"],
    absolute: ["/tmp/agentpier-escaped.txt"],
    notHistory: ["profiles/a/codex/auth.json"],
    applicationData: ["accounts.json"],
    duplicate: ["profiles/a/codex/sessions/x.jsonl", "profiles/a/codex/sessions/x.jsonl"],
  };
  for (const [name, history] of Object.entries(cases)) {
    const file = await craftedSeal(root, name, history);
    const target = path.join(root, `target-${name}`);
    await assert.rejects(
      restore.apply({ archive: file, targetDataDir: target, passphrase }),
      { message: serverMessages.backups.historyAuthenticationFailed },
      name,
    );
    assert.equal(fs.existsSync(target), false, name);
  }
  // Unknown fields in the record or its entries are refused as well.
  for (const [name, doctor] of Object.entries({
    extraField: (record) => ({ ...record, extra: true }),
    extraMemberField: (record) => ({
      ...record,
      members: record.members.map((member) => ({ ...member, mode: 0o755 })),
    }),
  })) {
    const file = await craftedSeal(
      root,
      name,
      ["profiles/a/codex/sessions/y.jsonl"],
      doctor,
    );
    await assert.rejects(
      restore.apply({
        archive: file,
        targetDataDir: path.join(root, `target-${name}`),
        passphrase,
      }),
      { message: serverMessages.backups.historyAuthenticationFailed },
      name,
    );
  }
  assert.equal(fs.existsSync("/tmp/agentpier-escaped.txt"), false);
  assert.deepEqual(
    outside(root).filter((name) => !name.endsWith(".src")),
    [],
  );
});

test("crafted credential member paths, in either format, are refused", async (t) => {
  const { root, restore } = setup(t);
  const capsule = await encryptCredentials(
    [
      {
        ...fileMember("profiles/a/secret.json", { apiKey: "x" }),
        path: "profiles/a/../../../out/x",
      },
    ],
    passphrase,
  );
  const v1 = path.join(root, "credential-v1.apbackup");
  fs.writeFileSync(
    v1,
    encodeArchive({
      format: "agentpier-backup",
      version: 1,
      manifest: { ...manifest, schemaVersion: 1 },
      files: [fileMember("accounts.json", [])],
      credentials: capsule,
    }),
  );
  const v2 = path.join(root, "credential-v2.apbackup");
  await writeArchive(v2, {
    manifest,
    capsule,
    members: [{ path: "accounts.json", bytes: Buffer.from("[]") }],
  });
  for (const file of [v1, v2]) {
    const target = path.join(root, `target-${path.basename(file)}`);
    await assert.rejects(
      restore.apply({ archive: file, targetDataDir: target, passphrase }),
      {
        status: 400,
      },
    );
    assert.equal(fs.existsSync(target), false);
  }
  assert.deepEqual(outside(root), []);
});

test("the stage guard resolves every path inside the stage and refuses links", (t) => {
  const { root } = setup(t);
  const stage = path.join(root, "stage");
  fs.mkdirSync(path.join(stage, "profiles"), { recursive: true });
  assert.equal(
    stagePath(stage, "profiles/a/codex/sessions/x.jsonl"),
    path.join(stage, "profiles/a/codex/sessions/x.jsonl"),
  );
  for (const name of ["../x", "/etc/passwd", "a/../../x", "", "a//b", "a\\b"])
    assert.throws(
      () => stagePath(stage, name),
      { message: serverMessages.backups.invalidMemberPath },
      name,
    );
  // A link inside the stage (never created by extraction) is not followed.
  fs.symlinkSync(root, path.join(stage, "linked"));
  assert.throws(() => stagePath(stage, "linked/x"), {
    message: serverMessages.backups.invalidMemberPath,
  });
  fs.writeFileSync(path.join(stage, "file"), "");
  assert.throws(() => stagePath(stage, "file/x"), {
    message: serverMessages.backups.invalidMemberPath,
  });
});

test("database work copies are owner-only and gone once archived", async (t) => {
  const { root } = setup(t);
  const { DatabaseSync } = await import("node:sqlite");
  const { sqliteSnapshotFileAsync, sqliteSnapshotFile } =
    await import("../../server/features/operations/snapshot.js");
  const source = path.join(root, "history.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE t(x); INSERT INTO t VALUES ('private')");
  db.close();
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch, { mode: 0o700 });
  const copies = [
    await sqliteSnapshotFileAsync(source, scratch),
    sqliteSnapshotFile(source, scratch),
  ];
  for (const copy of copies) assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  await writeArchive(path.join(root, "copies.apbackup"), {
    manifest: { ...manifest, withCredentials: false },
    members: copies.map((copy, index) => ({
      path: `memory/copy-${index}.sqlite`,
      file: copy,
      size: fs.statSync(copy).size,
      temporary: true,
    })),
  });
  assert.deepEqual(fs.readdirSync(scratch), []);
});
