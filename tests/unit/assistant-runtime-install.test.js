import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assistantInstallFixture } from "../helpers/assistant-install-fixture.js";
import {
  ensureAssistantRuntime,
  provisionEnabledRuntime,
} from "../../server/features/assistants/runtime-install.js";

function directory(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-install-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}
test("disabled installation never downloads an assistant runtime", async (t) => {
  const result = await provisionEnabledRuntime({
    dataDir: directory(t),
    download: () => assert.fail("unexpected download"),
  });
  assert.equal(result, null);
});
test("corrupt Node download cannot activate or replace a previous runtime", async (t) => {
  const dataDir = directory(t);
  fs.mkdirSync(path.join(dataDir, "assistants"));
  const active = path.join(dataDir, "assistants", "runtime.json");
  fs.writeFileSync(active, JSON.stringify({ version: "previous" }));
  await assert.rejects(
    ensureAssistantRuntime({ dataDir, download: async () => Buffer.from("corrupt") }),
    /checksum/i,
  );
  assert.equal(JSON.parse(fs.readFileSync(active)).version, "previous");
});
test("unsupported host fails before downloading", async (t) => {
  await assert.rejects(
    ensureAssistantRuntime({
      dataDir: directory(t),
      platform: "win32",
      arch: "x64",
      download: () => assert.fail(),
    }),
    /platform/i,
  );
});
test("symlinked assistant storage cannot install into another location", async (t) => {
  const dataDir = directory(t),
    outside = directory(t);
  fs.symlinkSync(outside, path.join(dataDir, "assistants"));
  await assert.rejects(ensureAssistantRuntime({ dataDir }), /storage/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("runtime selection rejects symlinked executable ancestors", async (t) => {
  const { selectedAssistantRuntime } =
    await import("../../server/features/assistants/runtime-install.js");
  const dataDir = directory(t),
    outside = directory(t);
  const root = path.join(dataDir, "assistants");
  fs.mkdirSync(path.join(root, "runtimes"), { recursive: true });
  fs.writeFileSync(path.join(outside, "node"), "outside executable");
  fs.symlinkSync(outside, path.join(root, "runtimes", "aliased"));
  const executable = path.join(root, "runtimes", "aliased", "node");
  fs.writeFileSync(
    path.join(root, "runtime.json"),
    JSON.stringify({ version: "old", nodePath: executable, entryPath: executable }),
  );
  await assert.rejects(selectedAssistantRuntime({ dataDir }), /unsafe/i);
});

test("fresh enable uses private Node and reuses a verified installation on update", async (t) => {
  const { dataDir, options } = assistantInstallFixture(t);
  const installed = await ensureAssistantRuntime(options);
  assert.equal(installed.version, "2026.9.8");
  assert.ok(fs.existsSync(installed.nodePath));
  assert.ok(fs.existsSync(installed.entryPath));
  const { stageAssistantRuntime, selectedAssistantRuntime } =
    await import("../../server/features/assistants/runtime-install.js");
  assert.equal(typeof stageAssistantRuntime, "function");
  const active = path.join(dataDir, "assistants", "runtime.json");
  const previous = { ...installed, version: "2026.9.7" };
  delete previous.dependencyLockSha256;
  fs.writeFileSync(active, JSON.stringify(previous));
  assert.equal((await stageAssistantRuntime(options)).version, installed.version);
  assert.deepEqual(JSON.parse(fs.readFileSync(active)), previous);
  // A selection without a dependency lock is refused, never silently started.
  await assert.rejects(selectedAssistantRuntime(options), {
    code: "RUNTIME_LOCK_MISSING",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(active)), previous);
  const locked = { ...installed };
  delete locked.teamPlugin;
  fs.writeFileSync(active, JSON.stringify(locked));
  fs.unlinkSync(path.join(installed.teamPlugin.directory, "index.js"));
  assert.deepEqual(await selectedAssistantRuntime(options), installed);
  assert.ok(
    fs.existsSync(path.join(installed.teamPlugin.directory, "index.js")),
    "startup repairs selected plugin assets without changing runtime version",
  );
  fs.writeFileSync(path.join(dataDir, "assistants", "settings.json"), '{"enabled":true}');
  assert.deepEqual(
    await provisionEnabledRuntime({
      ...options,
      download: () => assert.fail("downloaded cached runtime"),
    }),
    installed,
  );
});

test("a selection whose runtime directory vanished is reset and reinstalled", async (t) => {
  const { dataDir, options } = assistantInstallFixture(t);
  const { selectedAssistantRuntime } =
    await import("../../server/features/assistants/runtime-install.js");
  const installed = await ensureAssistantRuntime(options);
  const directory = path.resolve(installed.entryPath, "../../../..");
  fs.rmSync(directory, { recursive: true });
  const selected = await selectedAssistantRuntime(options);
  assert.equal(selected.diagnostic, "RUNTIME_REINSTALLED");
  assert.equal(selected.nodePath, installed.nodePath);
  assert.ok(fs.existsSync(installed.entryPath));
  const active = JSON.parse(
    fs.readFileSync(path.join(dataDir, "assistants", "runtime.json")),
  );
  assert.equal(active.dependencyLockSha256, installed.dependencyLockSha256);
  assert.equal(active.diagnostic, undefined);
});

test("a successful installation clears the npm download cache", async (t) => {
  const { dataDir, options } = assistantInstallFixture(t);
  const cache = path.join(dataDir, "assistants", "npm-cache");
  fs.mkdirSync(path.join(cache, "_cacache"), { recursive: true });
  fs.writeFileSync(path.join(cache, "_cacache", "entry"), "cached tarball");
  await ensureAssistantRuntime(options);
  assert.equal(fs.existsSync(cache), false);
});
