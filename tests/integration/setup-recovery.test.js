import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupFixture } from "../helpers/setup-fixture.js";
const execute = promisify(execFile);
test("state is reconciled under lock after another process completes setup", async (t) => {
  const f = await setupFixture(t);
  const nextArchive = await f.archive("2.0.0");
  const installerUrl = new URL("../../scripts/release-install.mjs", import.meta.url).href;
  const options = { ...f.options, service: false };
  const common = `import fs from "node:fs"; import { spawnSync } from "node:child_process"; import { installRelease } from ${JSON.stringify(installerUrl)};
    const options = JSON.parse(process.argv[1]); const stages = [];
    const dependencies = { run: async () => ({ stdout: "fixture" }), inspectService: async () => ({ state: "missing", listener: false }), releaseOptions: { smoke: async (dir) => stages.push(dir) } };`;
  const second = `${common} await installRelease(options, dependencies);`;
  const first = `${common}
    const open = fs.openSync; let intercepted = false;
    fs.openSync = function(file, ...args) {
      if (!intercepted && String(file).endsWith("/.setup-recovery.lock")) {
        intercepted = true;
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(second)}, JSON.stringify({ ...options, archive: ${JSON.stringify(nextArchive)} })], { encoding: "utf8" });
        if (child.status !== 0) throw Error(child.stderr);
      }
      return open.call(this, file, ...args);
    };
    const result = await installRelease(options, dependencies);
    console.log(JSON.stringify({ result, stages }));`;
  const { stdout } = await execute(process.execPath, [
    "--input-type=module",
    "-e",
    first,
    JSON.stringify(options),
  ]);
  const output = JSON.parse(stdout);
  assert.equal(output.result.version, "2.0.0");
  assert.equal(output.stages.length, 0);
  assert.equal(await fs.readlink(path.join(f.installRoot, "current")), "releases/2.0.0");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.installRoot, ".setup.json"), "utf8"))
      .initialVersion,
    "2.0.0",
  );
});
for (const kind of ["archive-temp", "current-temp"]) {
  test(`retry tolerates owned ${kind} after process interruption`, async (t) => {
    const f = await setupFixture(t);
    await assert.rejects(
      f.install(
        {},
        {
          afterPhase: async (phase) => {
            if (phase === "staged") throw Error("interrupted");
          },
        },
      ),
      /interrupted/,
    );
    const temporary = path.join(
      f.installRoot,
      kind === "archive-temp"
        ? `.setup-target.aprelease.${randomUUID()}.tmp`
        : `.current-${randomUUID()}`,
    );
    if (kind === "archive-temp")
      await fs.writeFile(temporary, "incomplete", { mode: 0o600 });
    else await fs.symlink("releases/1.0.0", temporary);
    assert.equal((await f.install()).version, "1.0.0");
    if (kind === "archive-temp")
      await assert.rejects(fs.lstat(temporary), { code: "ENOENT" });
    else assert.equal(await fs.readlink(temporary), "releases/1.0.0");
  });
}

for (const window of ["lock-only", "receipt-temp", "cache-rename", "pointer-rename"]) {
  test(`initial ${window} crash retains the recorded target and ownership`, async (t) => {
    const f = await setupFixture(t);
    const url = new URL("../../scripts/release-install.mjs", import.meta.url).href;
    const script = `import fs from "node:fs"; import { installRelease } from ${JSON.stringify(url)};
      const original = fs.${window === "lock-only" ? "openSync" : "renameSync"};
      fs.${window === "lock-only" ? "openSync" : "renameSync"} = function(file, ...args) {
        const interrupted = ${JSON.stringify(window)};
        if ((interrupted === "lock-only" || interrupted === "receipt-temp") && /\\/.setup-[a-f0-9-]+\\.tmp$/.test(String(file))) process.exit(9);
        if (interrupted === "cache-rename" && /\\/.setup-target\\.aprelease\\.[a-f0-9-]+\\.tmp$/.test(String(file))) process.exit(9);
        if (interrupted === "pointer-rename" && /\\/.current-[a-f0-9-]+$/.test(String(file))) process.exit(9);
        return original.call(this, file, ...args);
      };
      await installRelease(JSON.parse(process.argv[1]), { run: async () => ({ stdout: "fixture" }), inspectService: async () => ({ state: "missing", listener: false }), releaseOptions: { smoke: async () => {} } });`;
    await assert.rejects(
      execute(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify({ ...f.options, service: false }),
      ]),
      { code: 9 },
    );
    assert.equal((await f.install()).version, "1.0.0");
    const receipt = JSON.parse(
      await fs.readFile(path.join(f.installRoot, ".setup.json"), "utf8"),
    );
    assert.equal(receipt.initialVersion, "1.0.0");
  });
}

for (const kind of ["archive-link", "foreign-pointer", "unknown-file"]) {
  test(`retry preserves and rejects unowned ${kind} remnants`, async (t) => {
    const f = await setupFixture(t);
    await f.install();
    const name =
      kind === "archive-link"
        ? `.setup-target.aprelease.${randomUUID()}.tmp`
        : kind === "foreign-pointer"
          ? `.current-${randomUUID()}`
          : "user-file.tmp";
    const file = path.join(f.installRoot, name);
    if (kind === "archive-link") await fs.symlink(f.options.archive, file);
    else if (kind === "foreign-pointer") await fs.symlink("/foreign", file);
    else await fs.writeFile(file, "preserve", { mode: 0o600 });
    await assert.rejects(f.install(), /conflict/);
    assert.ok(await fs.lstat(file));
  });
}

for (const operation of ["writeFileSync", "fsyncSync", "renameSync"]) {
  test(`retry succeeds after initial receipt ${operation} fails`, async (t) => {
    const sync = await import("node:fs").then((module) => module.default);
    const f = await setupFixture(t);
    const open = sync.openSync,
      original = sync[operation];
    let receiptFd;
    sync.openSync = function (file, ...args) {
      const fd = open.call(this, file, ...args);
      if (/\/.setup-[a-f0-9-]+\.tmp$/.test(String(file))) receiptFd = fd;
      return fd;
    };
    sync[operation] = function (file, ...args) {
      if (
        operation === "renameSync"
          ? /\/.setup-[a-f0-9-]+\.tmp$/.test(String(file))
          : file === receiptFd
      )
        throw Object.assign(Error("simulated disk full"), { code: "ENOSPC" });
      return original.call(this, file, ...args);
    };
    try {
      await assert.rejects(f.install({ service: false }), { code: "ENOSPC" });
    } finally {
      sync.openSync = open;
      sync[operation] = original;
    }
    assert.equal((await f.install({ service: false })).version, "1.0.0");
  });
}
