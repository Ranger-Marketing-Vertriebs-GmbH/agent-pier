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
