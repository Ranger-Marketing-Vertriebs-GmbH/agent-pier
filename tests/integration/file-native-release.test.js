import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildRelease } from "../../scripts/release-package.mjs";
import { installRelease } from "../../scripts/release-install.mjs";
import {
  smokeRelease,
  unpackRelease,
} from "../../server/features/operations/release-archive.js";
import { Releases } from "../../server/features/operations/releases.js";
import { digest } from "../../server/features/operations/files.js";

const repository = path.resolve(import.meta.dirname, "../..");
const platformPackage = `@koromix/koffi-${process.platform}-${process.arch}`;
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-native-release-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  for (const name of [
    "server/features/files",
    "vendor",
    "dist",
    "scripts",
    "node_modules",
  ])
    await fs.mkdir(path.join(source, name), { recursive: true });
  for (const name of ["koffi", platformPackage, "node-pty"])
    await fs.cp(
      path.join(repository, "node_modules", name),
      path.join(source, "node_modules", name),
      { recursive: true },
    );
  for (const name of [
    "file-native.js",
    "file-native-worker.js",
    "file-native-linux.js",
    "file-native-darwin.js",
    "file-errors.js",
  ])
    await fs.copyFile(
      path.join(repository, "server/features/files", name),
      path.join(source, "server/features/files", name),
    );
  for (const [name, text] of Object.entries({
    "package.json": JSON.stringify({
      type: "module",
      version: "1.0.0",
      dependencies: { koffi: "3.2.1" },
    }),
    "package-lock.json": "{}",
    "server/index.js": "",
    "server/app.js": "export {};",
    "dist/index.html": "fixture",
    LICENSE: "Project license fixture",
    "THIRD_PARTY_NOTICES.md": "Fixture notices",
  }))
    await fs.writeFile(path.join(source, name), text);
  const nodeLicense = path.join(root, "node-LICENSE.txt");
  await fs.writeFile(nodeLicense, "Node runtime license fixture");
  return { root, source, nodeLicense };
}
async function relocatableRuntime(t, root) {
  const executable = path.join(root, "runtime-probe");
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o755);
  try {
    await promisify(execFile)(executable, ["--version"], { timeout: 5000 });
    return true;
  } catch (error) {
    const sharedRuntimeFailure =
      /Library not loaded:[^\n]*libnode[^\n]*\.dylib|error while loading shared libraries: libnode\.so/.test(
        error.stderr || "",
      );
    if (process.env.CI || !sharedRuntimeFailure) throw error;
    t.skip(
      "Copied Node executable requires shared libnode; use an official standalone Node build for relocation coverage.",
    );
    return false;
  } finally {
    await fs.rm(executable, { force: true });
  }
}

function revisedArchive(bytes, version, omit = () => false) {
  const archive = JSON.parse(gunzipSync(bytes));
  archive.manifest.version = version;
  archive.files = archive.files.filter((file) => !omit(file.path));
  for (const file of archive.files) {
    if (file.path !== "release.json" && file.path !== "package.json") continue;
    const value = JSON.parse(Buffer.from(file.content, "base64"));
    value.version = version;
    const content = Buffer.from(JSON.stringify(value));
    file.content = content.toString("base64");
    file.sha256 = digest(content);
  }
  return gzipSync(JSON.stringify(archive));
}

test("packaged native support survives relocation, initial installation and update staging", async (t) => {
  const f = await fixture(t);
  if (!(await relocatableRuntime(t, f.root))) return;
  const archive = path.join(f.root, "release.aprelease");
  await buildRelease({
    source: f.source,
    output: archive,
    node: process.execPath,
    nodeLicense: f.nodeLicense,
    prepareDependencies: false,
  });
  const bytes = await fs.readFile(archive);
  await fs.rm(f.source, { recursive: true });
  const unpacked = path.join(f.root, "unpacked");
  await fs.mkdir(unpacked);
  unpackRelease(bytes, unpacked);
  await smokeRelease(unpacked);
  assert.match(
    await fs.readFile(path.join(unpacked, "node_modules/koffi/LICENSE.txt"), "utf8"),
    /MIT License/,
  );
  const installRoot = path.join(f.root, "install");
  const dataDir = path.join(f.root, "data");
  await installRelease(
    { archive, installRoot, dataDir, installDependencies: false },
    { run: async () => ({ stdout: "fixture tool available" }) },
  );
  assert.equal(await fs.readlink(path.join(installRoot, "current")), "releases/1.0.0");
  const releases = new Releases({ installRoot, dataDir });
  const update = path.join(f.root, "update.aprelease");
  await fs.writeFile(update, revisedArchive(bytes, "1.1.0"));
  assert.equal((await releases.stage({ archive: update })).version, "1.1.0");
  await smokeRelease(path.join(installRoot, "releases/1.1.0"));
  const broken = path.join(f.root, "broken.aprelease");
  await fs.writeFile(
    broken,
    revisedArchive(bytes, "1.2.0", (name) =>
      name.startsWith(`node_modules/${platformPackage}/`),
    ),
  );
  await assert.rejects(releases.stage({ archive: broken }), /native dependency smoke/);
  await assert.rejects(fs.access(path.join(installRoot, "releases/1.2.0")), {
    code: "ENOENT",
  });
  assert.equal(await fs.readlink(path.join(installRoot, "current")), "releases/1.0.0");
  assert.equal(
    (await fs.readdir(installRoot)).some((name) => name.startsWith(".staging-")),
    false,
  );

  // Even a resolvable ancestor installation must not mask absent release payloads.
  await fs.mkdir(path.join(f.root, "node_modules/@koromix"), { recursive: true });
  await fs.rename(
    path.join(unpacked, "node_modules", platformPackage),
    path.join(f.root, "node_modules", platformPackage),
  );
  await assert.rejects(smokeRelease(unpacked), /native dependency smoke/);
  await fs.rename(
    path.join(unpacked, "node_modules/koffi"),
    path.join(f.root, "node_modules/koffi"),
  );
  await assert.rejects(smokeRelease(unpacked), /native dependency smoke/);
  // Historical releases do not declare or ship the native explorer foundation.
  await fs.writeFile(
    path.join(unpacked, "package.json"),
    '{"type":"module","version":"0.9.0"}',
  );
  await smokeRelease(unpacked);
});
