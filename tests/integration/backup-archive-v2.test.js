import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  archiveVersion,
  readArchive,
  readArchiveHeader,
  writeArchive,
} from "../../server/features/operations/archive-v2.js";
import { encodeArchive } from "../../server/features/operations/archive.js";
import { profileComponent } from "../../server/features/operations/backup-components.js";
import { fileHeader, padding } from "../../server/features/operations/tar.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = { createdAt: "2026-10-12T10:00:00.000Z", withCredentials: false };
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-v2-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
/** Extracts every member below `target`; returns collected member paths. */
async function extract(file, target) {
  const seen = [];
  const header = await readArchive(file, {
    visit: (member) => {
      seen.push(member.path);
      return member.kind === "credentials"
        ? { collect: () => {} }
        : { file: path.join(target, member.path) };
    },
  });
  return { header, seen };
}
/** A tar.gz from raw entries: `{ name, data, type?, mode? }` or a raw `block`. */
function craft(entries, { end = true } = {}) {
  const parts = [];
  for (const entry of entries) {
    if (entry.raw) {
      parts.push(entry.raw);
      continue;
    }
    const data = Buffer.from(entry.data);
    const header = fileHeader(entry.name, entry.size ?? data.length);
    if (entry.type || entry.mode !== undefined) {
      const block = header.subarray(header.length - 512);
      if (entry.type) block.write(entry.type, 156, 1, "latin1");
      if (entry.mode !== undefined)
        block.write(entry.mode.toString(8).padStart(7, "0") + "\0", 100, "latin1");
      block.fill(0x20, 148, 156);
      let sum = 0;
      for (const byte of block) sum += byte;
      block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
    }
    parts.push(header, data, padding(data.length));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
function headerEntry(members, extra = {}) {
  return {
    name: "agentpier-backup.json",
    data: JSON.stringify({
      format: "agentpier-backup",
      version: 2,
      manifest: { schemaVersion: 2, withCredentials: false, ...extra },
      members: members.map((m) => ({
        path: m.path,
        size: m.size ?? Buffer.byteLength(m.data),
        sha256: m.sha256 ?? sha(Buffer.from(m.data)),
        mode: 0o600,
        kind: m.kind ?? "public",
      })),
    }),
  };
}

test("version 2 archives stream members with their header first and round-trip exactly", async (t) => {
  const root = temp(t);
  const large = path.join(root, "large.bin");
  const content = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < content.length; i++) content[i] = (i * 7919) % 251;
  fs.writeFileSync(large, content);
  const longName = `profiles/a/claude/projects/${"ä-".repeat(80)}/session.jsonl`;
  const file = path.join(root, "backup.apbackup");
  const size = await writeArchive(file, {
    manifest: { ...manifest, withCredentials: true },
    capsule: { header: { version: 1 }, data: "c2VhbGVk", tag: "dGFn" },
    members: [
      { path: "accounts.json", bytes: Buffer.from("[]") },
      { path: "preferences.json", content: Buffer.from("{}").toString("base64") },
      { path: longName, bytes: Buffer.from("unicode path") },
      { path: "profiles/a/codex/sessions/big.jsonl", file: large, size: content.length },
      { path: "empty.json", bytes: Buffer.alloc(0) },
    ],
  });
  assert.equal(size, fs.statSync(file).size);
  assert.equal(await archiveVersion(file), 2);
  const header = await readArchiveHeader(file);
  assert.deepEqual(
    header.members.map((m) => [m.path, m.kind]),
    [
      ["credentials.json", "credentials"],
      ["accounts.json", "public"],
      ["preferences.json", "public"],
      [longName, "public"],
      ["profiles/a/codex/sessions/big.jsonl", "public"],
      ["empty.json", "public"],
    ],
  );
  assert.equal(header.manifest.schemaVersion, 2);
  assert.equal(header.members[4].sha256, sha(content));
  const target = path.join(root, "out");
  await extract(file, target);
  assert.deepEqual(
    fs.readFileSync(path.join(target, "profiles/a/codex/sessions/big.jsonl")),
    content,
  );
  assert.equal(fs.readFileSync(path.join(target, longName), "utf8"), "unicode path");
  assert.equal(fs.statSync(path.join(target, "accounts.json")).mode & 0o777, 0o600);
  // The multi-member gzip stays a plain tar.gz for standard tools.
  assert.equal(gunzipSync(fs.readFileSync(file)).length % 512, 0);
  const tar = spawnSync("tar", ["-tzf", file], { encoding: "utf8" });
  if (!tar.error) {
    assert.equal(tar.status, 0, tar.stderr);
    assert.ok(tar.stdout.split("\n").includes("agentpier-backup.json"));
    assert.ok(tar.stdout.includes("profiles/a/codex/sessions/big.jsonl"));
  }
  // The original JSON format is still recognized.
  const v1 = path.join(root, "v1.apbackup");
  fs.writeFileSync(
    v1,
    encodeArchive({ format: "agentpier-backup", version: 1, manifest: {}, files: [] }),
  );
  assert.equal(await archiveVersion(v1), 1);
  fs.writeFileSync(path.join(root, "junk"), gzipSync(Buffer.from("not an archive")));
  await assert.rejects(archiveVersion(path.join(root, "junk")), {
    message: serverMessages.backups.invalidArchive,
  });
});

test("a planned file that shrank fails the backup with its component's name", async (t) => {
  const root = temp(t);
  const source = path.join(root, "rollout.jsonl");
  fs.writeFileSync(source, "short");
  await assert.rejects(
    writeArchive(path.join(root, "a.apbackup"), {
      manifest,
      members: [
        {
          path: "profiles/a/codex/sessions/rollout.jsonl",
          file: source,
          size: 100,
          component: profileComponent({ name: "Work", tool: "codex" }),
        },
      ],
    }),
    { message: serverMessages.backups.profileChanged("Work", "Codex") },
  );
  fs.symlinkSync(source, path.join(root, "link"));
  await assert.rejects(
    writeArchive(path.join(root, "b.apbackup"), {
      manifest,
      members: [
        {
          path: "chat/x.json",
          file: path.join(root, "link"),
          size: 5,
          component: { area: "chat" },
        },
      ],
    }),
    { message: serverMessages.backups.unreadable.chat },
  );
  // A file that grew is captured as the planned prefix.
  fs.appendFileSync(source, " and longer");
  const file = path.join(root, "c.apbackup");
  await writeArchive(file, {
    manifest,
    members: [{ path: "sessions/x.screen", file: source, size: 5 }],
  });
  const target = path.join(root, "out");
  await extract(file, target);
  assert.equal(fs.readFileSync(path.join(target, "sessions/x.screen"), "utf8"), "short");
});

test("crafted version 2 archives are rejected without writing outside the target", async (t) => {
  const root = temp(t);
  const ok = { path: "accounts.json", data: "[]" };
  const cases = {
    traversal: [
      headerEntry([{ path: "../escape", data: "x" }]),
      { name: "../escape", data: "x" },
    ],
    absolute: [
      headerEntry([{ path: "/tmp/escape", data: "x" }]),
      { name: "/tmp/escape", data: "x" },
    ],
    symlink: [headerEntry([ok]), { name: "accounts.json", data: "", type: "2" }],
    hardLink: [headerEntry([ok]), { name: "accounts.json", data: "", type: "1" }],
    directory: [headerEntry([ok]), { name: "accounts.json", data: "", type: "5" }],
    executable: [headerEntry([ok]), { name: "accounts.json", data: "[]", mode: 0o755 }],
    duplicate: [
      headerEntry([ok, ok]),
      { name: "accounts.json", data: "[]" },
      { name: "accounts.json", data: "[]" },
    ],
    fileDirectory: [
      headerEntry([
        { path: "a", data: "x" },
        { path: "a/b", data: "y" },
      ]),
      { name: "a", data: "x" },
      { name: "a/b", data: "y" },
    ],
    checksum: [
      headerEntry([{ ...ok, sha256: "0".repeat(64) }]),
      { name: "accounts.json", data: "[]" },
    ],
    renamed: [headerEntry([ok]), { name: "preferences.json", data: "[]" }],
    sizeDiffers: [headerEntry([ok]), { name: "accounts.json", data: "[ ]" }],
    extra: [
      headerEntry([ok]),
      { name: "accounts.json", data: "[]" },
      { name: "x", data: "1" },
    ],
    missing: [
      headerEntry([ok, { path: "b", data: "1" }]),
      { name: "accounts.json", data: "[]" },
    ],
    headerNotFirst: [{ name: "accounts.json", data: "[]" }, headerEntry([ok])],
    unknownMemberKey: [
      {
        name: "agentpier-backup.json",
        data: JSON.stringify({
          format: "agentpier-backup",
          version: 2,
          manifest: { schemaVersion: 2, withCredentials: false },
          members: [
            {
              path: "accounts.json",
              size: 2,
              sha256: sha("[]"),
              mode: 384,
              kind: "public",
              link: "/x",
            },
          ],
        }),
      },
      { name: "accounts.json", data: "[]" },
    ],
    capsuleWithoutManifest: [
      headerEntry([{ path: "credentials.json", data: "{}", kind: "credentials" }]),
      { name: "credentials.json", data: "{}" },
    ],
    trailingData: [
      headerEntry([ok]),
      { name: "accounts.json", data: "[]" },
      { raw: Buffer.alloc(1024) },
      { raw: Buffer.from("junk") },
    ],
  };
  const expected = {
    traversal: "invalidMemberPath",
    absolute: "invalidMemberPath",
    duplicate: "invalidMember",
    unknownMemberKey: "invalidMember",
    fileDirectory: "fileDirectoryConflict",
    checksum: "checksumMismatch",
    renamed: "memberMismatch",
    sizeDiffers: "memberMismatch",
    extra: "memberMismatch",
    missing: "memberMismatch",
    capsuleWithoutManifest: "credentialManifestMismatch",
  };
  for (const [name, entries] of Object.entries(cases)) {
    const file = path.join(root, `${name}.apbackup`);
    fs.writeFileSync(file, craft(entries));
    const target = path.join(root, "targets", name);
    fs.mkdirSync(target, { recursive: true });
    await assert.rejects(
      extract(file, target),
      { message: serverMessages.backups[expected[name] || "invalidArchive"] },
      name,
    );
  }
  const truncatedFile = path.join(root, "truncated.apbackup");
  const big = Buffer.alloc(200000, 1);
  const whole = craft([
    headerEntry([{ path: "big", data: big }]),
    { name: "big", data: big },
  ]);
  fs.writeFileSync(truncatedFile, whole.subarray(0, whole.length - 40));
  await assert.rejects(extract(truncatedFile, path.join(root, "targets/truncated")), {
    message: serverMessages.backups.invalidArchive,
  });
  const unsupported = path.join(root, "v3.apbackup");
  fs.writeFileSync(
    unsupported,
    craft([
      {
        name: "agentpier-backup.json",
        data: JSON.stringify({ format: "agentpier-backup", version: 3 }),
      },
    ]),
  );
  await assert.rejects(readArchiveHeader(unsupported), {
    message: serverMessages.backups.unsupportedFormat,
  });
  // Nothing escaped the per-case targets.
  assert.deepEqual(
    fs
      .readdirSync(root)
      .filter((name) => !name.endsWith(".apbackup"))
      .sort(),
    ["targets"],
  );
  assert.equal(fs.existsSync(path.join(path.dirname(root), "escape")), false);
});
