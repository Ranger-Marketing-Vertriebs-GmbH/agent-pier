import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { gzipSync } from "node:zlib";
import {
  encodeArchive,
  decodeArchive,
  encryptCredentials,
  decryptCredentials,
} from "../../server/features/operations/archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";
import { relativeName } from "../../server/features/operations/files.js";
const params = {
  seed: Number(process.env.FC_SEED || 260907),
  numRuns: Number(process.env.FC_RUNS || 100),
};
test("compressed expansion cannot exceed the configured archive budget", () => {
  assert.throws(
    () => decodeArchive(gzipSync(Buffer.alloc(4096)), { limit: 1024 }),
    /oversized/,
  );
});
test("logical archive preserves arbitrary Unicode content and rejects corrupt members", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 10000 }), (content) => {
      const archive = {
        format: "agentpier-backup",
        version: 1,
        manifest: { schemaVersion: 1 },
        files: [fileMember("preferences.json", Buffer.from(content))],
      };
      assert.equal(
        Buffer.from(
          decodeArchive(encodeArchive(archive)).files[0].content,
          "base64",
        ).toString(),
        content,
      );
      archive.files[0].sha256 = "0".repeat(64);
      assert.throws(() => decodeArchive(encodeArchive(archive)), /checksum/);
    }),
    params,
  );
});
test("archive path validation rejects traversal, linked entries and duplicate destinations", () => {
  fc.assert(
    fc.property(
      fc.array(fc.stringMatching(/^[a-z]{1,12}$/), { minLength: 1, maxLength: 6 }),
      (parts) => {
        const name = parts.join("/");
        assert.equal(relativeName(name), name);
        for (const invalid of [
          `../${name}`,
          `${name}/../outside`,
          `/${name}`,
          `${name}\\outside`,
        ])
          assert.throws(() => relativeName(invalid));
        const item = fileMember(name, Buffer.from("test"));
        const archive = {
          format: "agentpier-backup",
          version: 1,
          manifest: { schemaVersion: 1 },
          files: [item, item],
        };
        assert.throws(() => decodeArchive(encodeArchive(archive)), /Duplicate/);
        archive.files = [{ ...item, type: "symlink", link: "/outside" }];
        assert.throws(() => decodeArchive(encodeArchive(archive)), /linked/);
      },
    ),
    params,
  );
});
test("credential authentication rejects ciphertext and bounded KDF tampering", async () => {
  const capsule = await encryptCredentials(
    [fileMember("profiles/a/secret.json", { apiKey: "fixture" })],
    "a sufficiently long fixture passphrase",
  );
  const plain = await decryptCredentials(
    capsule,
    "a sufficiently long fixture passphrase",
  );
  assert.equal(plain.length, 1);
  await assert.rejects(
    decryptCredentials(
      { ...capsule, data: Buffer.from("broken").toString("base64") },
      "a sufficiently long fixture passphrase",
    ),
    /authentication/,
  );
  await assert.rejects(
    decryptCredentials(
      { ...capsule, header: { ...capsule.header, N: 2 ** 30 } },
      "a sufficiently long fixture passphrase",
    ),
    /parameters/,
  );
});
