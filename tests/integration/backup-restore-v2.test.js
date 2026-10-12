import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { writeArchive } from "../../server/features/operations/archive-v2.js";
import { encryptCredentials } from "../../server/features/operations/archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";
import { Restore } from "../../server/features/operations/restore.js";
import { encodeArchiveV2 } from "../helpers/backup-archive.js";

const passphrase = "restore fixture passphrase";
const account = "11111111-2222-3333-4444-555555555555";
const manifest = {
  createdAt: "2026-10-12T10:00:00.000Z",
  applicationVersion: "1.29.0",
  includeHistory: true,
  withCredentials: true,
  consistency: "per-component-snapshots; independent-native-captures",
  omissions: [],
  captures: [],
};
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-rv2-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, "live");
  fs.mkdirSync(live);
  return { root, restore: new Restore({ dataDir: live }) };
}
const accounts = [{ id: account, name: "Work", tool: "codex", kind: "managed" }];
const secrets = [
  fileMember(`profiles/${account}/codex/auth.json`, { tokens: { access: "secret" } }),
  fileMember(`profiles/${account}/codex/config.toml`, Buffer.from('model = "x"\n')),
];
async function archive(
  root,
  name,
  { members = [], credentials = secrets, meta = {} } = {},
) {
  const file = path.join(root, `${name}.apbackup`);
  await writeArchive(file, {
    manifest: { ...manifest, ...meta },
    capsule: credentials ? await encryptCredentials(credentials, passphrase) : undefined,
    members: [
      { path: "accounts.json", bytes: Buffer.from(JSON.stringify(accounts)) },
      ...members,
    ],
  });
  return file;
}

test("a version 2 archive restores public history and sealed credentials into a new data folder", async (t) => {
  const { root, restore } = setup(t);
  const transcript = path.join(root, "rollout.jsonl");
  fs.writeFileSync(transcript, '{"type":"session_meta"}\n'.repeat(1000));
  const file = await archive(root, "full", {
    members: [
      {
        path: `profiles/${account}/codex/sessions/2026/10/12/rollout.jsonl`,
        file: transcript,
        size: fs.statSync(transcript).size,
      },
    ],
  });
  const inspection = await restore.inspect({ archive: file });
  assert.equal(inspection.requiresPassphrase, true);
  assert.equal(inspection.credentialsIncluded, true);
  // An inspection writes nothing it does not validate and removes its scratch folder.
  assert.deepEqual(
    fs.readdirSync(restore.directory).filter((name) => name.startsWith(".")),
    [],
  );
  await assert.rejects(
    restore.inspect({ archive: file, passphrase: "wrong passphrase!" }),
    {
      message: serverMessages.backups.authenticationFailed,
    },
  );
  const target = path.join(root, "restored");
  const report = await restore.apply({
    archive: file,
    targetDataDir: target,
    passphrase,
  });
  assert.deepEqual(report.credentialsNeedingLogin, []);
  assert.equal(
    fs.readFileSync(path.join(target, `profiles/${account}/codex/auth.json`), "utf8"),
    '{"tokens":{"access":"secret"}}',
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(target, `profiles/${account}/codex/sessions/2026/10/12/rollout.jsonl`),
    ),
    fs.readFileSync(transcript),
  );
  assert.equal(
    fs.statSync(path.join(target, `profiles/${account}/codex/auth.json`)).mode & 0o777,
    0o600,
  );
});

test("a version 2 restore rejects members outside the allowlists before writing a target", async (t) => {
  const { root, restore } = setup(t);
  const cases = {
    cache: {
      members: [
        { path: `profiles/${account}/codex/cache/x.json`, bytes: Buffer.from("{}") },
      ],
    },
    log: {
      members: [
        { path: `profiles/${account}/codex/logs_2.sqlite`, bytes: Buffer.from("x") },
      ],
    },
    publicCredential: {
      members: [
        { path: `profiles/${account}/codex/auth.json`, bytes: Buffer.from("{}") },
      ],
      credentials: null,
      meta: { withCredentials: false },
    },
    sealedHistory: {
      credentials: [
        fileMember(`profiles/${account}/codex/sessions/a.jsonl`, Buffer.from("x")),
      ],
    },
    sealedUnknown: {
      credentials: [fileMember(`profiles/${account}/claude/statsig/x`, Buffer.from("x"))],
    },
    unknownTop: {
      members: [{ path: "operations/backups/x.json", bytes: Buffer.from("{}") }],
    },
  };
  for (const [name, options] of Object.entries(cases)) {
    const file = await archive(root, name, options);
    const target = path.join(root, `target-${name}`);
    await assert.rejects(
      restore.apply({ archive: file, targetDataDir: target, passphrase }),
      { message: serverMessages.backups.unexpectedComponent },
      name,
    );
    assert.equal(fs.existsSync(target), false, name);
  }
  // A wrong passphrase fails on the capsule, before any history is written.
  const file = await archive(root, "passphrase");
  await assert.rejects(
    restore.apply({
      archive: file,
      targetDataDir: path.join(root, "target-passphrase"),
      passphrase: "not the passphrase",
    }),
    { message: serverMessages.backups.authenticationFailed },
  );
  await assert.rejects(
    restore.apply({ archive: file, targetDataDir: path.join(root, "target-none") }),
    { message: serverMessages.backups.passphraseRequired },
  );
  assert.deepEqual(
    fs
      .readdirSync(root)
      .filter((name) => !name.endsWith(".apbackup"))
      .sort(),
    ["live"],
  );
});

test("an inspection stops after the members it validates; a restore verifies all", async (t) => {
  const { root, restore } = setup(t);
  const archive = {
    manifest: { ...manifest, withCredentials: false },
    files: [
      { path: "accounts.json", content: Buffer.from("[]").toString("base64") },
      {
        path: `profiles/${account}/codex/sessions/a.jsonl`,
        content: Buffer.from("{}\n").toString("base64"),
        // Declared wrong: only a full read notices.
        sha256: "0".repeat(64),
      },
    ],
  };
  const file = path.join(root, "late.apbackup");
  fs.writeFileSync(file, encodeArchiveV2(archive));
  assert.equal((await restore.inspect({ archive: file })).credentialsIncluded, false);
  await assert.rejects(
    restore.apply({ archive: file, targetDataDir: path.join(root, "target") }),
    { message: serverMessages.backups.checksumMismatch },
  );
  assert.equal(fs.existsSync(path.join(root, "target")), false);
});

test("files rewritten while archived come back only when line-based", async (t) => {
  const { root, restore } = setup(t);
  const source = (name, content) => {
    fs.writeFileSync(path.join(root, name), content);
    return { file: path.join(root, name), size: Buffer.byteLength(content) };
  };
  const image = `profiles/${account}/codex/generated_images/a/img.png`;
  const transcript = `profiles/${account}/codex/sessions/2026/a.jsonl`;
  const steady = `profiles/${account}/codex/generated_images/a/steady.png`;
  const file = path.join(root, "changed.apbackup");
  const written = await writeArchive(file, {
    manifest: { ...manifest, withCredentials: false },
    members: [
      { path: "accounts.json", bytes: Buffer.from(JSON.stringify(accounts)) },
      { path: image, ...source("img.png", "PNG-old-content") },
      { path: transcript, ...source("a.jsonl", '{"a":1}\n') },
      { path: steady, ...source("steady.png", "PNG-steady") },
    ],
    // Rewritten in place (same size) and appended to while being archived.
    opened: (entry) => {
      const earlier = new Date(Date.now() - 60_000);
      if (entry.path === image) {
        fs.writeFileSync(entry.file, "PNG-new-content");
        fs.utimesSync(entry.file, earlier, earlier);
      }
      if (entry.path === transcript) {
        fs.appendFileSync(entry.file, '{"a":2}\n');
        fs.utimesSync(entry.file, earlier, earlier);
      }
    },
  });
  assert.deepEqual(written.changed.sort(), [image, transcript].sort());
  const target = path.join(root, "restored");
  const report = await restore.apply({ archive: file, targetDataDir: target });
  assert.deepEqual(report.changedFilesLeftOut, [image]);
  assert.equal(fs.existsSync(path.join(target, image)), false);
  assert.equal(fs.readFileSync(path.join(target, transcript), "utf8"), '{"a":1}\n');
  assert.equal(fs.readFileSync(path.join(target, steady), "utf8"), "PNG-steady");
});
