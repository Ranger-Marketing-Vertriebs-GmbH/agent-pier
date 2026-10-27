import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshReaLock } from "../../scripts/refresh-rea-lock.mjs";
import { reaManifest } from "../../server/features/tools/rea-manifest.js";

// The maintainer script never writes a lockfile for a tarball the manifest does not
// pin: a registry integrity other than reaManifest.core.integrity stops it before
// anything is resolved or written.
test("refreshReaLock refuses to write the lock when the integrity differs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "rea-package-lock.json");
  const { name, version } = reaManifest.core;
  const other = "sha512-c29tZXRoaW5nIGVsc2U=";
  const urls = [];
  const download = async (url) => {
    urls.push(url);
    return Buffer.from(
      JSON.stringify({ name, versions: { [version]: { dist: { integrity: other } } } }),
    );
  };
  await assert.rejects(
    refreshReaLock({ dataDir: dir, output, download }),
    (error) =>
      error.message.includes(other) && error.message.includes(reaManifest.core.integrity),
  );
  assert.equal(urls.length, 1);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});
