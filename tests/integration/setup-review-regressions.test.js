import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupFixture } from "../helpers/setup-fixture.js";
import { Releases } from "../../server/features/operations/releases.js";
const execute = promisify(execFile);
const activationUrl = new URL(
  "../../server/features/operations/release-activation.js",
  import.meta.url,
).href;

test("repair accepts a later release pointer left by an interrupted app upgrade", async (t) => {
  const f = await setupFixture(t);
  await f.install({ service: false });
  await new Releases({
    dataDir: f.dataDir,
    installRoot: f.installRoot,
    smoke: async () => {},
  }).stage({ archive: await f.archive("2.0.0") });
  const script = `import fs from "node:fs";
    import { switchRelease } from ${JSON.stringify(activationUrl)};
    fs.renameSync = () => process.exit(9);
    switchRelease(process.argv[1], "2.0.0");`;
  await assert.rejects(
    execute(process.execPath, ["--input-type=module", "-e", script, f.installRoot]),
    { code: 9 },
  );
  const temporary = (await fs.readdir(f.installRoot)).find((name) =>
    name.startsWith(".current-"),
  );
  assert.ok(temporary);
  const result = await f.install({ service: false });
  assert.equal(result.version, "1.0.0");
  assert.equal(await fs.readlink(path.join(f.installRoot, "current")), "releases/1.0.0");
  assert.equal(await fs.readlink(path.join(f.installRoot, temporary)), "releases/2.0.0");
});

test("repair preserves a release pointer while another process is switching it", async (t) => {
  const f = await setupFixture(t);
  await f.install({ service: false });
  const installerUrl = new URL("../../scripts/release-install.mjs", import.meta.url).href;
  const installer = `import { installRelease } from ${JSON.stringify(installerUrl)};
    await installRelease(JSON.parse(process.argv[1]), {
      run: async () => ({ stdout: "fixture" }),
      inspectService: async () => ({ state: "missing", listener: false }),
    });`;
  const script = `import fs from "node:fs";
    import { spawnSync } from "node:child_process";
    import { switchRelease } from ${JSON.stringify(activationUrl)};
    const rename = fs.renameSync;
    fs.renameSync = function(...args) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(installer)}, process.argv[1]], { encoding: "utf8" });
      if (result.status !== 0) throw Error(result.stderr);
      return rename.apply(this, args);
    };
    switchRelease(JSON.parse(process.argv[1]).installRoot, "1.0.0");`;
  await execute(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    JSON.stringify({ ...f.options, service: false }),
  ]);
  assert.equal(await fs.readlink(path.join(f.installRoot, "current")), "releases/1.0.0");
});

for (const state of ["missing", "conflict"]) {
  test(`no-service installs and repairs beside an unrelated ${state} service and listener`, async (t) => {
    const f = await setupFixture(t);
    f.state.service = state;
    f.state.listener = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.install({ service: false });
      assert.equal(result.serviceInstalled, false);
      assert.equal(result.version, "1.0.0");
    }
    assert.equal(f.restartCalls.length, 0);
    assert.equal(f.state.service, state);
    assert.equal(f.state.listener, true);
  });
}

test("a recovery guard before the first receipt reports recovery and preserves the root", async (t) => {
  const f = await setupFixture(t);
  await fs.mkdir(f.installRoot);
  const guard = path.join(f.installRoot, ".setup-recovery.lock");
  await fs.writeFile(guard, "interrupted recovery", { mode: 0o600 });
  await assert.rejects(f.install(), /recovery is in progress.*\.setup-recovery\.lock/);
  assert.deepEqual(await fs.readdir(f.installRoot), [".setup-recovery.lock"]);
  assert.equal(await fs.readFile(guard, "utf8"), "interrupted recovery");
  await assert.rejects(fs.stat(f.dataDir), { code: "ENOENT" });
});

test("repair preserves an inactive pointer after its old release was cleaned up", async (t) => {
  const f = await setupFixture(t);
  await f.install({ service: false });
  await new Releases({
    dataDir: f.dataDir,
    installRoot: f.installRoot,
    smoke: async () => {},
  }).stage({ archive: await f.archive("2.0.0") });
  const { switchRelease } = await import(activationUrl);
  switchRelease(f.installRoot, "2.0.0");
  const { randomUUID } = await import("node:crypto");
  const temporary = path.join(f.installRoot, `.current-${randomUUID()}`);
  await fs.symlink("releases/1.0.0", temporary);
  await fs.rm(path.join(f.installRoot, "releases/1.0.0"), { recursive: true });
  assert.equal((await f.install({ service: false })).version, "2.0.0");
  assert.equal(await fs.readlink(temporary), "releases/1.0.0");
});

for (const target of ["releases/../foreign", "releases/..", "releases/not-a-version"]) {
  test(`repair rejects and preserves a temporary pointer to ${target}`, async (t) => {
    const f = await setupFixture(t);
    await f.install({ service: false });
    const { randomUUID } = await import("node:crypto");
    const temporary = path.join(f.installRoot, `.current-${randomUUID()}`);
    await fs.symlink(target, temporary);
    await assert.rejects(f.install({ service: false }), /conflict/);
    assert.equal(await fs.readlink(temporary), target);
  });
}
