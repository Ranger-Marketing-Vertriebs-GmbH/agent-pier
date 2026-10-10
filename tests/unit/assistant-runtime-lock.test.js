import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stageAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { assistantInstallFixture } from "../helpers/assistant-install-fixture.js";

test("fresh runtime uses verified bundled dependency graph and pinned npm ci", async (t) => {
  const f = assistantInstallFixture(t);
  const execute = f.options.execute;
  f.options.execute = async (command, args, options) => {
    if (args.includes("ci")) {
      assert.equal(
        fs.readFileSync(path.join(options.cwd, "package-lock.json"), "utf8"),
        fs.readFileSync(path.join(f.lockDirectory, "package-lock.json"), "utf8"),
      );
      assert.ok(args.includes("--ignore-scripts"));
      assert.ok(args.includes("--include=optional"));
      assert.equal(fs.readFileSync(options.env.npm_config_userconfig, "utf8"), "");
      assert.equal(fs.readFileSync(options.env.npm_config_globalconfig, "utf8"), "");
      assert.ok(fs.existsSync(path.join(options.cwd, "openclaw.tgz")));
    }
    return execute(command, args, options);
  };
  const installed = await stageAssistantRuntime(f.options);
  assert.equal(f.commands.filter((x) => x.args.includes("ci")).length, 1);
  assert.equal(
    f.commands.some((x) => x.args.includes("install")),
    false,
  );
  assert.equal(installed.dependencyLockSha256, f.manifest.dependencyLockSha256);
  assert.ok(installed.nodePath.includes(f.manifest.dependencyLockSha256.slice(0, 12)));
  const cached = await stageAssistantRuntime({
    ...f.options,
    download: () => assert.fail("unexpected download"),
    execute: () => assert.fail("unexpected execution"),
  });
  assert.equal(cached.nodePath, installed.nodePath);
});

test("changed or missing dependency lock fails before any download", async (t) => {
  const f = assistantInstallFixture(t);
  fs.appendFileSync(path.join(f.lockDirectory, "package-lock.json"), " ");
  await assert.rejects(
    stageAssistantRuntime({
      ...f.options,
      download: () => assert.fail("lock must be checked before download"),
    }),
    /lock.*integrity/i,
  );
  fs.rmSync(path.join(f.lockDirectory, "package-lock.json"));
  await assert.rejects(
    stageAssistantRuntime({
      ...f.options,
      download: () => assert.fail("missing lock must fail"),
    }),
  );
});

test("same-version dependency revisions stage beside the active runtime", async (t) => {
  const f = assistantInstallFixture(t);
  const first = await stageAssistantRuntime(f.options);
  const selection = path.join(f.dataDir, "assistants/runtime.json");
  fs.writeFileSync(selection, JSON.stringify(first));
  const file = path.join(f.lockDirectory, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(file));
  lock.packages["node_modules/synthetic"] = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/synthetic/-/synthetic-1.0.0.tgz",
    integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
  };
  fs.writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
  const second = await stageAssistantRuntime({
    ...f.options,
    manifest: { ...f.manifest, dependencyLockSha256: f.digest() },
  });
  assert.notEqual(second.nodePath, first.nodePath);
  assert.deepEqual(JSON.parse(fs.readFileSync(selection)), first);
  assert.ok(fs.existsSync(first.nodePath));
});

test("failed locked install retains prior selection and removes only its staging directory", async (t) => {
  const f = assistantInstallFixture(t);
  const root = path.join(f.dataDir, "assistants");
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, "runtime.json"),
    JSON.stringify({ version: "previous" }),
  );
  const execute = f.options.execute;
  await assert.rejects(
    stageAssistantRuntime({
      ...f.options,
      execute: (command, args, options) => {
        if (args.includes("ci")) throw Error("locked package unavailable");
        return execute(command, args, options);
      },
    }),
    /locked package unavailable/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "runtime.json"))), {
    version: "previous",
  });
  assert.deepEqual(fs.readdirSync(path.join(root, "runtimes")), []);
});

test("cached locked installation rejects changed lock bytes without reinstalling", async (t) => {
  const f = assistantInstallFixture(t);
  const installed = await stageAssistantRuntime(f.options);
  const app = path.resolve(installed.entryPath, "../../..");
  fs.appendFileSync(path.join(app, "package-lock.json"), " ");
  await assert.rejects(
    stageAssistantRuntime({
      ...f.options,
      download: () => assert.fail("must not repair in place"),
    }),
    /lock.*integrity/i,
  );
});

test("locked graph rejects unpinned and non-registry dependencies before downloads", async (t) => {
  for (const entry of [
    {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/unsafe/-/unsafe-1.0.0.tgz",
    },
    {
      version: "1.0.0",
      resolved: "https://example.invalid/unsafe.tgz",
      integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
    },
    { version: "1.0.0", inBundle: true },
    { version: "1.0.0", link: true, resolved: "../outside" },
  ]) {
    const f = assistantInstallFixture(t);
    const file = path.join(f.lockDirectory, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(file));
    lock.packages["node_modules/unsafe"] = entry;
    fs.writeFileSync(file, JSON.stringify(lock));
    await assert.rejects(
      stageAssistantRuntime({
        ...f.options,
        manifest: { ...f.manifest, dependencyLockSha256: f.digest() },
        download: () => assert.fail("invalid graph must fail before download"),
      }),
      /dependency|bundled/i,
    );
  }
});

test("shipped dependency graph covers native packages for all supported hosts", async () => {
  const { readRuntimeLock } =
    await import("../../server/features/assistants/runtime-lock.js");
  const { runtimeManifest } =
    await import("../../server/features/assistants/runtime-manifest.js");
  const { lockBytes } = readRuntimeLock(runtimeManifest);
  const { packages } = JSON.parse(lockBytes);
  for (const platform of ["darwin", "linux"])
    for (const arch of ["arm64", "x64"]) {
      for (const name of [
        `@lydell/node-pty-${platform}-${arch}`,
        `sqlite-vec-${platform}-${arch}`,
        `@openclaw/fs-safe-${platform}-${arch}${platform === "linux" ? "-gnu" : ""}`,
      ]) {
        const entry = packages[`node_modules/${name}`];
        assert.ok(entry?.optional, `${name} must remain in cross-platform lock`);
        assert.ok(entry.os.includes(platform));
        assert.ok(entry.cpu.includes(arch));
        assert.ok(entry.integrity.startsWith("sha512-"));
      }
    }
});

test("starting a selected locked runtime rejects altered dependency metadata", async (t) => {
  const f = assistantInstallFixture(t);
  const installed = await stageAssistantRuntime(f.options);
  fs.writeFileSync(
    path.join(f.dataDir, "assistants/runtime.json"),
    JSON.stringify(installed),
  );
  const { selectedAssistantRuntime } =
    await import("../../server/features/assistants/runtime-install.js");
  assert.equal((await selectedAssistantRuntime(f.options)).nodePath, installed.nodePath);
  fs.appendFileSync(
    path.join(path.resolve(installed.entryPath, "../../.."), "package-lock.json"),
    " ",
  );
  await assert.rejects(selectedAssistantRuntime(f.options), /lock.*integrity/i);
});

test("lock refresh rejects mismatched npm without downloading or replacing output", async (t) => {
  const { refreshAssistantRuntimeLock } =
    await import("../../scripts/refresh-assistant-runtime-lock.mjs");
  const f = assistantInstallFixture(t);
  const original = fs.readFileSync(
    path.join(f.lockDirectory, "package-lock.json"),
    "utf8",
  );
  await assert.rejects(
    refreshAssistantRuntimeLock({
      runtimeDirectory: path.join(f.root, "runtime"),
      outputDirectory: f.lockDirectory,
      manifest: f.manifest,
      download: () => assert.fail("wrong npm must not resolve a new graph"),
      execute: async (_command, args) => ({
        stdout: args.length === 1 ? "v26.7.0\n" : "99.0.0\n",
      }),
    }),
    /manifest-pinned/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.lockDirectory, "package-lock.json"), "utf8"),
    original,
  );
});
