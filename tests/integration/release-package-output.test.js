import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildRelease } from "../../scripts/release-package.mjs";
import { unpackRelease } from "../../server/features/operations/release-archive.js";
import { digest } from "../../server/features/operations/files.js";
async function fixture(t, exitCode = 0) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-package-output-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    parent = path.join(root, "shared output"),
    alias = path.join(root, "alias");
  for (const name of ["server", "vendor", "dist", "scripts", "node_modules/node-pty"])
    await fs.mkdir(path.join(source, name), { recursive: true });
  await fs.mkdir(parent, { mode: 0o755 });
  await fs.chmod(parent, 0o755);
  await fs.symlink(parent, alias);
  for (const [name, value] of Object.entries({
    "package.json": JSON.stringify({ type: "module", version: "1.0.0" }),
    "package-lock.json": "{}",
    LICENSE: "Project license fixture",
    "THIRD_PARTY_NOTICES.md": "Dependency notices fixture",
    "server/index.js": "",
    "server/app.js": "",
    "dist/index.html": "fixture",
    "node_modules/node-pty/package.json": "{}",
  }))
    await fs.writeFile(path.join(source, name), value);
  const node = path.join(root, "node-fixture");
  await fs.writeFile(path.join(root, "node-LICENSE.txt"), "Node license fixture");
  await fs.writeFile(node, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
  return { root, source, parent, alias, node };
}
test("release builder accepts a declared output parent alias without changing its permissions", async (t) => {
  const { root, source, parent, alias, node } = await fixture(t);
  const output = path.join(alias, "custom-release.aprelease");
  const result = await buildRelease({ source, output, node, prepareDependencies: false });
  const bytes = await fs.readFile(output);
  assert.equal(result.file, "custom-release.aprelease");
  assert.equal(result.sha256, digest(bytes));
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(JSON.parse(await fs.readFile(`${output}.json`)), result);
  assert.equal((await fs.stat(parent)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(`${output}.json`)).mode & 0o777, 0o600);
  const unpacked = path.join(root, "unpacked");
  await fs.mkdir(unpacked);
  assert.equal(unpackRelease(bytes, unpacked).version, "1.0.0");
  for (const [name, expected] of Object.entries({
    LICENSE: "Project license fixture",
    "THIRD_PARTY_NOTICES.md": "Dependency notices fixture",
    "third-party/node-LICENSE.txt": "Node license fixture",
  })) {
    assert.equal(await fs.readFile(path.join(unpacked, name), "utf8"), expected);
  }
});
test("release output links are rejected without replacing their external targets", async (t) => {
  const { source, parent, node, root } = await fixture(t);
  const output = path.join(parent, "release.aprelease"),
    external = path.join(root, "unrelated");
  await fs.writeFile(external, "preserve");
  await fs.symlink(external, output);
  await assert.rejects(
    buildRelease({ source, output, node, prepareDependencies: false }),
    /output.*regular|output.*link/i,
  );
  assert.equal(await fs.readFile(external, "utf8"), "preserve");
  assert.ok((await fs.lstat(output)).isSymbolicLink());
});
test("failed relocated smoke does not publish over an existing output artifact", async (t) => {
  const { source, parent, node } = await fixture(t, 1);
  const output = path.join(parent, "release.aprelease");
  await fs.writeFile(output, "previous archive");
  await fs.writeFile(`${output}.json`, "previous metadata");
  await assert.rejects(
    buildRelease({ source, output, node, prepareDependencies: false }),
    /smoke/,
  );
  assert.equal(await fs.readFile(output, "utf8"), "previous archive");
  assert.equal(await fs.readFile(`${output}.json`, "utf8"), "previous metadata");
  assert.equal((await fs.stat(parent)).mode & 0o777, 0o755);
});

test("a custom runtime without its license cannot publish a release", async (t) => {
  const { source, parent, node, root } = await fixture(t);
  await fs.unlink(path.join(root, "node-LICENSE.txt"));
  const output = path.join(parent, "release.aprelease");
  await assert.rejects(
    buildRelease({ source, output, node, prepareDependencies: false }),
  );
  await assert.rejects(fs.access(output));
});
