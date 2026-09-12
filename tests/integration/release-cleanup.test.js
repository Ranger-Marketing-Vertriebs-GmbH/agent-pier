import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Releases } from "../../server/features/operations/releases.js";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ap-release-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"),
    installRoot = path.join(root, "install");
  await fs.mkdir(dataDir);
  for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
    const dir = path.join(installRoot, "releases", version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify({ version }));
    await fs.writeFile(path.join(dir, "payload"), "fixture");
  }
  await fs.symlink("releases/1.2.0", path.join(installRoot, "current"));
  return new Releases({ dataDir, installRoot, processes: () => "" });
}
test("cleanup removes selected old versions and stale receipts but preserves current and newer releases", async (t) => {
  const r = await fixture(t);
  await fs.writeFile(
    path.join(r.directory, "abc.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  assert.deepEqual(
    r
      .cleanupStatus()
      .versions.filter((v) => v.canDelete)
      .map((v) => v.version),
    ["1.0.0", "1.1.0"],
  );
  assert.deepEqual(await r.cleanup(["1.0.0"]), { removedVersions: ["1.0.0"] });
  assert.deepEqual(await fs.readdir(path.join(r.installRoot, "releases")), [
    "1.1.0",
    "1.2.0",
    "1.3.0",
  ]);
  assert.deepEqual(await fs.readdir(r.directory), []);
  await r.cleanup(["1.1.0"]);
  assert.equal(await fs.readlink(path.join(r.installRoot, "current")), "releases/1.2.0");
});
test("bulk cleanup rechecks every version and refuses active processes, new versions and path traversal", async (t) => {
  const r = await fixture(t);
  r.processes = () =>
    `${r.installRoot}/releases/1.1.0/bin/node ${r.installRoot}/releases/1.1.0/server/terminal-launcher.js`;
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.1.0").deleteReason,
    "inUse",
  );
  for (const versions of [
    ["1.0.0", "1.1.0"],
    ["1.2.0"],
    ["1.3.0"],
    ["../data"],
    [],
    ["1.0.0", "1.0.0"],
  ])
    await assert.rejects(r.cleanup(versions));
  assert.ok(await fs.stat(path.join(r.installRoot, "releases/1.0.0")));
  r.processes = () => {
    throw Error("ps failed");
  };
  await assert.rejects(r.cleanup(["1.0.0"]));
});
test("activation locks and symlinked releases prevent cleanup without touching external data", async (t) => {
  const r = await fixture(t);
  const lock = path.join(r.dataDir, "operations/release-activation.lock");
  await fs.writeFile(lock, "fixture lock");
  await assert.rejects(r.cleanup(["1.0.0"]), /pending/);
  assert.equal(await fs.readFile(lock, "utf8"), "fixture lock");
  await fs.unlink(lock);
  await fs.rm(path.join(r.installRoot, "releases/1.0.0"), { recursive: true });
  await fs.symlink(r.dataDir, path.join(r.installRoot, "releases/1.0.0"));
  await assert.rejects(r.cleanup(["1.0.0"]));
  assert.ok(await fs.stat(r.dataDir));
});

test("a real fixture process protects its release until it exits", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { releaseProcesses } =
    await import("../../server/features/operations/release-cleanup.js");
  const r = await fixture(t);
  const script = path.join(r.installRoot, "releases/1.0.0/fixture.cjs");
  await fs.writeFile(
    script,
    "process.stdout.write('ready'); setInterval(() => {}, 1000);",
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => child.kill());
  const closed = once(child, "close");
  await once(child.stdout, "data");
  r.processes = releaseProcesses;
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
  await assert.rejects(r.cleanup(["1.0.0"]));
  child.kill();
  await closed;
  await r.cleanup(["1.0.0"]);
});

test("a tmux server's historical startup arguments do not pin an unused release", async (t) => {
  const { releaseProcessReferences } =
    await import("../../server/features/operations/release-cleanup.js");
  const r = await fixture(t);
  const old = `${r.installRoot}/releases/1.0.0`;
  r.processes = () =>
    releaseProcessReferences(
      `tmux tmux new-session '${old}/bin/node' '${old}/server/terminal-launcher.js'`,
    );
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").canDelete,
    true,
  );
  r.processes = () =>
    releaseProcessReferences(
      `tmux tmux new-session '${old}/bin/node'\nnode node ${old}/vendor/agentbus/mcp-server.js`,
    );
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
  r.processes = () =>
    releaseProcessReferences(`${old}/bin/tmux ${old}/bin/tmux new-session`);
  assert.equal(
    r.cleanupStatus().versions.find((v) => v.version === "1.0.0").deleteReason,
    "inUse",
  );
});
