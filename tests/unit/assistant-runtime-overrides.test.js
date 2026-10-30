import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  readRuntimeLock,
  lockedOverrides,
} from "../../server/features/assistants/runtime-lock.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import {
  selectedAssistantRuntime,
  stageAssistantRuntime,
} from "../../server/features/assistants/runtime-install.js";
import { assistantInstallFixture } from "../helpers/assistant-install-fixture.js";

const atLeast = (version, minimum) => {
  const a = version.split(".").map(Number),
    b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

// Writes overrides and an overridden transitive package into a fixture lock.
function addOverride(f, { declared = true, locked = "8.12.3" } = {}) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(f.lockDirectory, name)));
  const pkg = read("package.json"),
    lock = read("package-lock.json");
  if (declared) pkg.overrides = { undici: "8.12.3" };
  lock.packages["node_modules/undici"] = {
    version: locked,
    resolved: `https://registry.npmjs.org/undici/-/undici-${locked}.tgz`,
    integrity: `sha512-${createHash("sha512").update(locked).digest("base64")}`,
  };
  for (const [name, value] of [
    ["package.json", pkg],
    ["package-lock.json", lock],
  ])
    fs.writeFileSync(
      path.join(f.lockDirectory, name),
      JSON.stringify(value, null, 2) + "\n",
    );
  return {
    ...f.manifest,
    dependencyOverrides: { undici: "8.12.3" },
    dependencyLockSha256: f.digest(),
  };
}

test("shipped runtime graph resolves the patched security versions", () => {
  const { packageBytes, lockBytes } = readRuntimeLock(runtimeManifest);
  assert.deepEqual(JSON.parse(packageBytes).overrides, lockedOverrides(runtimeManifest));
  const { packages } = JSON.parse(lockBytes);
  // Advisories fixed in undici 8.12.2 and zod 4.6.6.
  for (const [name, minimum] of [
    ["undici", "8.12.2"],
    ["zod", "4.6.6"],
  ]) {
    const copies = Object.entries(packages).filter(([key]) =>
      key.endsWith(`node_modules/${name}`),
    );
    assert.ok(copies.length > 0, name);
    for (const [key, entry] of copies)
      assert.ok(atLeast(entry.version, minimum), `${key}@${entry.version}`);
  }
});

test("lock validation requires the manifest overrides and their versions", (t) => {
  const missing = assistantInstallFixture(t);
  assert.throws(
    () =>
      readRuntimeLock(addOverride(missing, { declared: false }), missing.lockDirectory),
    /lock metadata/,
  );
  const stale = assistantInstallFixture(t);
  assert.throws(
    () => readRuntimeLock(addOverride(stale, { locked: "8.11.2" }), stale.lockDirectory),
    /override not applied/,
  );
  assert.throws(
    () => lockedOverrides({ dependencyOverrides: { undici: "^8.12.3" } }),
    /Invalid assistant dependency override/,
  );
  const valid = assistantInstallFixture(t);
  const manifest = addOverride(valid);
  assert.ok(readRuntimeLock(manifest, valid.lockDirectory));
  // The manifest's overrides are part of the contract: dropping them fails too.
  assert.throws(
    () => readRuntimeLock({ ...manifest, dependencyOverrides: {} }, valid.lockDirectory),
    /lock metadata/,
  );
});

test("an installed runtime records its overrides and starts from its receipt", async (t) => {
  const f = assistantInstallFixture(t);
  const manifest = addOverride(f);
  const options = { ...f.options, manifest };
  const installed = await stageAssistantRuntime(options);
  const directory = path.resolve(installed.entryPath, "../../../..");
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "receipt.json")));
  assert.deepEqual(receipt.dependencyOverrides, { undici: "8.12.3" });
  fs.writeFileSync(
    path.join(f.dataDir, "assistants/runtime.json"),
    JSON.stringify(installed),
  );
  assert.equal((await selectedAssistantRuntime(options)).nodePath, installed.nodePath);
});

test("a runtime installed before overrides existed still starts", async (t) => {
  const f = assistantInstallFixture(t);
  const installed = await stageAssistantRuntime(f.options);
  const directory = path.resolve(installed.entryPath, "../../../..");
  const file = path.join(directory, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(file));
  delete receipt.dependencyOverrides;
  fs.writeFileSync(file, JSON.stringify(receipt));
  fs.writeFileSync(
    path.join(f.dataDir, "assistants/runtime.json"),
    JSON.stringify(installed),
  );
  assert.equal((await selectedAssistantRuntime(f.options)).nodePath, installed.nodePath);
});

test("lock refresh writes the manifest overrides into the locked package.json", async (t) => {
  const { refreshAssistantRuntimeLock } =
    await import("../../scripts/refresh-assistant-runtime-lock.mjs");
  const f = assistantInstallFixture(t);
  const manifest = addOverride(f);
  const output = path.join(f.root, "output");
  const result = await refreshAssistantRuntimeLock({
    runtimeDirectory: path.join(f.root, "runtime"),
    outputDirectory: output,
    manifest,
    download: f.options.download,
    execute: async (_command, args, options) => {
      if (args.length === 1) return { stdout: "v26.7.0\n" };
      if (args.length === 2) return { stdout: "11.19.0\n" };
      const pkg = JSON.parse(fs.readFileSync(path.join(options.cwd, "package.json")));
      assert.deepEqual(pkg.overrides, { undici: "8.12.3" });
      fs.copyFileSync(
        path.join(f.lockDirectory, "package-lock.json"),
        path.join(options.cwd, "package-lock.json"),
      );
      return { stdout: "" };
    },
  });
  const { packageBytes } = readRuntimeLock(
    { ...manifest, dependencyLockSha256: result.dependencyLockSha256 },
    output,
  );
  assert.deepEqual(JSON.parse(packageBytes).overrides, { undici: "8.12.3" });
});
