import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { decryptCredentials } from "../../server/features/operations/archive.js";
import { profileMemberKind } from "../../server/features/operations/profile-allowlist.js";
import { remapClaudeProjects } from "../../server/features/operations/profile-history.js";
import { archiveText, loadArchive } from "../helpers/backup-archive.js";
import {
  credentialFiles,
  excludedFiles,
  historyFiles,
  threadHistory,
  writeCliProfiles,
} from "../helpers/cli-profile-fixture.js";

const passphrase = "cli profile fixture passphrase";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-cli-")));
  const dataDir = path.join(root, "data");
  const db = writeCliProfiles(dataDir);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, home: path.join(root, "home") };
}
const secretValues = [
  "sk-codex-secret",
  "codex-oauth-secret",
  "codex-mcp-oauth-secret",
  "claude-oauth-secret",
  "opencode-api-secret",
];

test("CLI profiles are captured by allowlist: credentials sealed, history only when chosen", async (t) => {
  const { root, dataDir, home } = fixture(t);
  const backup = new Backup({ dataDir, home });
  for (const withCredentials of [false, true])
    for (const includeHistory of [false, true]) {
      const created = await backup.create({
        withCredentials,
        includeHistory,
        ...(withCredentials ? { passphrase } : {}),
      });
      const archive = loadArchive(created.file);
      const profiles = archive.files
        .map((member) => member.path)
        .filter((name) => name.startsWith("profiles/"))
        .sort();
      const label = `credentials=${withCredentials} history=${includeHistory}`;
      assert.deepEqual(
        profiles,
        includeHistory ? [...Object.keys(historyFiles), threadHistory].sort() : [],
        label,
      );
      // No credential value and nothing outside the allowlists in any public byte.
      const text = archiveText(created.file);
      for (const value of [...secretValues, "sentinel"])
        assert.equal(text.includes(value), false, `${label}: ${value}`);
      assert.equal(
        created.manifest.omissions.includes("CLI conversation histories"),
        !includeHistory,
      );
      if (!withCredentials) {
        assert.equal(archive.credentials, undefined);
        continue;
      }
      const sealed = await decryptCredentials(archive.credentials, passphrase);
      assert.deepEqual(
        sealed.map((member) => member.path).sort(),
        Object.keys(credentialFiles).sort(),
        label,
      );
      for (const member of sealed)
        assert.equal(
          Buffer.from(member.content, "base64").toString(),
          credentialFiles[member.path],
        );
      if (!includeHistory) continue;
      const target = path.join(root, `restored-${Date.now()}`);
      const report = await new Restore({ dataDir }).apply({
        archive: created.file,
        targetDataDir: target,
        passphrase,
      });
      // Every profile comes back logged in, with byte-identical credential files.
      assert.deepEqual(report.credentialsNeedingLogin, []);
      for (const [name, content] of Object.entries({
        ...credentialFiles,
        ...historyFiles,
      }))
        assert.equal(fs.readFileSync(path.join(target, name), "utf8"), content, name);
      for (const name of Object.keys(excludedFiles))
        assert.equal(fs.existsSync(path.join(target, name)), false, name);
      // The history database is a consistent snapshot, including its WAL content.
      const restored = new DatabaseSync(path.join(target, threadHistory), {
        readOnly: true,
      });
      assert.equal(
        restored.prepare("SELECT title FROM threads").get().title,
        "First thread",
      );
      restored.close();
    }
});

test("a credential tree above the capsule limit fails the backup naming the profile", async (t) => {
  const { dataDir, home } = fixture(t);
  const skill = path.join(dataDir, "profiles/claude-home/claude/skills/huge/blob.bin");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, Buffer.alloc(65 * 1024 * 1024));
  await assert.rejects(
    new Backup({ dataDir, home }).create({ withCredentials: true, passphrase }),
    {
      message: serverMessages.backups.profileCredentialLimit(
        "Home",
        "Claude Code",
        "64.0 MiB",
      ),
    },
  );
  // Without credentials the tree is not read at all.
  await new Backup({ dataDir, home }).create({ includeHistory: false });
});

test("restore paths are classified by the same allowlist", () => {
  const cases = {
    "profiles/a/secret.json": "secret",
    "profiles/a/codex/auth.json": "credentials",
    "profiles/a/providers/zai/codex/config.toml": "credentials",
    "profiles/a/codex/sessions/2026/a.jsonl": "history",
    "profiles/a/codex/thread_history_1.sqlite": "history",
    "profiles/a/config/opencode/opencode.json": "credentials",
    "profiles/a/data/opencode/opencode.db": "history",
    "profiles/a/codex/logs_2.sqlite": null,
    "profiles/a/codex/thread_history_1.sqlite-wal": null,
    "profiles/a/codex/sessions/cache/a": null,
    "profiles/a/claude/projects/-w/a.jsonl": "history",
    "profiles/a/claude/statsig/x": null,
    "profiles/a/claude/plugins/marketplaces/m/x": null,
    "profiles/a/other/auth.json": null,
    "profiles/../codex/auth.json": null,
    "profiles/a/providers/../codex/auth.json": null,
    "profiles/a/codex": null,
  };
  for (const [name, kind] of Object.entries(cases))
    assert.equal(profileMemberKind(name), kind, name);
});

test("restored Claude Code transcripts follow a remapped project directory", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-remap-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, "profiles/a/claude/projects");
  fs.mkdirSync(path.join(projects, "-old-repo"), { recursive: true });
  fs.writeFileSync(path.join(projects, "-old-repo/s.jsonl"), "{}");
  remapClaudeProjects(root, [{ oldCwd: "/old/repo", cwd: "/new.dir/repo" }]);
  assert.equal(
    fs.readFileSync(path.join(projects, "-new-dir-repo/s.jsonl"), "utf8"),
    "{}",
  );
  assert.equal(fs.existsSync(path.join(projects, "-old-repo")), false);
});
