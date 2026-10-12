import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  CHUNK,
  sealChunks,
  sealedSize,
  sealHistory,
  Unsealer,
} from "../../server/features/operations/history-seal.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { encodeArchiveV2, loadArchive } from "../helpers/backup-archive.js";
import { historyFiles, writeCliProfiles } from "../helpers/cli-profile-fixture.js";

const failure = { message: serverMessages.backups.historyAuthenticationFailed };
const passphrase = "sealed history fixture passphrase";
async function sealPlain(plain, overrides = {}) {
  const { members } = sealHistory("backup-id", [
    { path: "profiles/a/codex/history.jsonl" },
  ]);
  const sealInfo = { ...members[0].seal, ...overrides };
  const parts = [];
  for await (const chunk of sealChunks([plain], plain.length, sealInfo))
    parts.push(chunk);
  return { sealed: Buffer.concat(parts), seal: members[0].seal };
}
function open(sealed, seal, size = sealed.length) {
  const unsealer = new Unsealer(seal, size);
  const out = [];
  // Feed in odd slices, as a stream would.
  for (let offset = 0; offset < sealed.length; offset += 70001)
    out.push(...unsealer.update(sealed.subarray(offset, offset + 70001)));
  out.push(...unsealer.final());
  return Buffer.concat(out);
}

test("sealed chunks round-trip at every size and reveal no plaintext", async () => {
  for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + CHUNK / 2]) {
    const plain = randomBytes(size);
    const { sealed, seal } = await sealPlain(plain);
    assert.equal(sealed.length, sealedSize(size), String(size));
    assert.deepEqual(open(sealed, seal), plain);
    if (size > 64) assert.equal(sealed.includes(plain.subarray(0, 64)), false);
  }
});

test("tampered, truncated, reordered, moved or foreign-key chunks are rejected", async () => {
  const plain = randomBytes(3 * CHUNK + 100);
  const { sealed, seal } = await sealPlain(plain);
  const step = CHUNK + 16;
  const flipped = Buffer.from(sealed);
  flipped[CHUNK + 20] ^= 1;
  assert.throws(() => open(flipped, seal), failure);
  // Without its last chunk, the shorter entry ends with a chunk not marked last.
  assert.throws(() => open(sealed.subarray(0, 3 * step), seal), failure);
  // A last chunk cut short.
  assert.throws(() => open(sealed.subarray(0, sealed.length - 10), seal), failure);
  const swapped = Buffer.concat([
    sealed.subarray(step, 2 * step),
    sealed.subarray(0, step),
    sealed.subarray(2 * step),
  ]);
  assert.throws(() => open(swapped, seal), failure);
  // Bound to its path and entry: it cannot be restored as another file.
  assert.throws(
    () => open(sealed, { ...seal, path: "profiles/a/codex/other.jsonl" }),
    failure,
  );
  assert.throws(() => open(sealed, { ...seal, entry: 1 }), failure);
  assert.throws(() => open(sealed, { ...seal, key: randomBytes(32) }), failure);
  assert.throws(() => open(sealed, { ...seal, id: "another-backup" }), failure);
  assert.throws(() => new Unsealer(seal, 10), failure);
});

test("a restore with an altered sealed history aborts and leaves no target", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-seal-")));
  const dataDir = path.join(root, "data");
  const db = writeCliProfiles(dataDir);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const created = await new Backup({ dataDir, home: path.join(root, "home") }).create({
    withCredentials: true,
    passphrase,
  });
  const restore = new Restore({ dataDir });
  // Inspection with the passphrase opens the capsule but needs no history.
  assert.equal(
    (await restore.inspect({ archive: created.file, passphrase })).credentialsIncluded,
    true,
  );
  const archive = loadArchive(created.file);
  const cases = {
    // Altered ciphertext with a matching archive checksum.
    altered: (files) => {
      const member = files.find((entry) => entry.path === "sealed/0");
      const bytes = Buffer.from(member.content, "base64");
      bytes[0] ^= 1;
      member.content = bytes.toString("base64");
      member.sha256 = undefined;
    },
    // Two sealed entries swapped: each is bound to its own path.
    swapped: (files) => {
      const [a, b] = files.filter((entry) => /^sealed\/[01]$/.test(entry.path));
      [a.content, b.content] = [b.content, a.content];
      a.sha256 = b.sha256 = undefined;
    },
    // An entry the capsule does not list.
    unknown: (files) => {
      const member = files.find((entry) => entry.path === "sealed/0");
      files.push({ ...member, path: `sealed/${files.length + 100}` });
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    const copy = structuredClone(archive);
    change(copy.files);
    const file = path.join(root, `${name}.apbackup`);
    fs.writeFileSync(file, encodeArchiveV2(copy));
    const target = path.join(root, `target-${name}`);
    await assert.rejects(
      restore.apply({ archive: file, targetDataDir: target, passphrase }),
      name === "unknown"
        ? { message: serverMessages.backups.unexpectedComponent }
        : failure,
      name,
    );
    assert.equal(fs.existsSync(target), false, name);
  }
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith(".agentpier-restore-")),
    [],
  );
  // The unaltered archive restores every history file byte for byte.
  const target = path.join(root, "restored");
  await restore.apply({ archive: created.file, targetDataDir: target, passphrase });
  for (const [name, content] of Object.entries(historyFiles))
    assert.equal(fs.readFileSync(path.join(target, name), "utf8"), content, name);
  await assert.rejects(
    restore.apply({
      archive: created.file,
      targetDataDir: path.join(root, "wrong"),
      passphrase: "not the right passphrase",
    }),
    { message: serverMessages.backups.authenticationFailed },
  );
});
