import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  applyBundlePatches,
  bundlePatchId,
  runtimeBundlePatches,
  verifyBundlePatches,
} from "../../server/features/assistants/runtimes/openclaw/runtime-bundle-patches.js";
import {
  ensureAssistantRuntime,
  selectedAssistantRuntime,
  shippedRuntime,
} from "../../server/features/assistants/runtimes/openclaw/runtime-install.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { assistantInstallFixture } from "../helpers/assistant-install-fixture.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const file = "dist/lease-shared.mjs";
const original = "//#region\nconst RETRY_MS = 2e3;\nexport { RETRY_MS as t };\n";
const patches = {
  "1.0.0": [
    {
      id: "retry",
      file,
      before: "const RETRY_MS = 2e3;",
      after: "const RETRY_MS = 3e4;",
    },
  ],
};

// A package directory holding `text` at `file` and OpenClaw's content inventory.
function packageDir(t, text = original) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-patch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, file), text);
  const inventory = [
    { path: "dist/other.mjs", sha256: "0".repeat(64), mode: 420, size: 1 },
    { path: file, sha256: sha256(Buffer.from(text)), mode: 420, size: text.length },
  ];
  fs.writeFileSync(
    path.join(dir, "dist/postinstall-content-inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  return dir;
}
const read = (dir, name = file) => fs.readFileSync(path.join(dir, name), "utf8");
const inventoryOf = (dir) =>
  JSON.parse(read(dir, "dist/postinstall-content-inventory.json"));

test("a patch replaces its text once and records the file in OpenClaw's inventory", (t) => {
  const dir = packageDir(t);
  const id = applyBundlePatches(dir, "1.0.0", patches);
  assert.equal(id, bundlePatchId("1.0.0", patches));
  assert.match(id, /^[a-f0-9]{12}$/);
  const patched = read(dir);
  assert.equal(patched, original.replace("2e3", "3e4"));
  const entry = inventoryOf(dir).find((item) => item.path === file);
  assert.deepEqual(entry, {
    path: file,
    sha256: sha256(Buffer.from(patched)),
    mode: 420,
    size: Buffer.byteLength(patched),
  });
  // Other entries and the file's layout stay as they were.
  assert.equal(inventoryOf(dir)[0].sha256, "0".repeat(64));
  verifyBundlePatches(dir, "1.0.0", patches);
});

test("a second application changes nothing", (t) => {
  const dir = packageDir(t);
  applyBundlePatches(dir, "1.0.0", patches);
  const once = [read(dir), read(dir, "dist/postinstall-content-inventory.json")];
  assert.equal(
    applyBundlePatches(dir, "1.0.0", patches),
    bundlePatchId("1.0.0", patches),
  );
  assert.deepEqual(
    [read(dir), read(dir, "dist/postinstall-content-inventory.json")],
    once,
  );
});

test("a package that does not hold the text exactly once refuses the installation", (t) => {
  const refused = { code: "RUNTIME_PATCH_MISMATCH" };
  // Missing, changed upstream, twice, and half applied.
  const missing = packageDir(t);
  fs.rmSync(path.join(missing, file));
  assert.throws(() => applyBundlePatches(missing, "1.0.0", patches), refused);
  for (const text of [
    original.replace("2e3", "5e3"),
    original + "const RETRY_MS = 2e3;\n",
    original + "const RETRY_MS = 3e4;\n",
  ]) {
    const dir = packageDir(t, text);
    assert.throws(() => applyBundlePatches(dir, "1.0.0", patches), refused);
    assert.equal(read(dir), text, "nothing is written");
  }
  // A symlink is no package file.
  const linked = packageDir(t);
  fs.renameSync(path.join(linked, file), path.join(linked, "dist/real.mjs"));
  fs.symlinkSync(path.join(linked, "dist/real.mjs"), path.join(linked, file));
  assert.throws(() => applyBundlePatches(linked, "1.0.0", patches), refused);
  // An inventory that does not record the original file.
  const stale = packageDir(t);
  const inventory = inventoryOf(stale);
  inventory[1].sha256 = "f".repeat(64);
  fs.writeFileSync(
    path.join(stale, "dist/postinstall-content-inventory.json"),
    JSON.stringify(inventory),
  );
  assert.throws(() => applyBundlePatches(stale, "1.0.0", patches), refused);
  // Verification refuses an unpatched package.
  assert.throws(() => verifyBundlePatches(packageDir(t), "1.0.0", patches), refused);
});

test("patches are scoped to their version", (t) => {
  const dir = packageDir(t);
  assert.equal(applyBundlePatches(dir, "1.0.1", patches), undefined);
  assert.equal(read(dir), original);
  assert.equal(bundlePatchId("1.0.1", patches), undefined);
  verifyBundlePatches(dir, "1.0.1", patches);
});

test("the pinned version's patches", () => {
  const list = runtimeBundlePatches[runtimeManifest.version];
  assert.deepEqual(
    list.map((patch) => patch.id),
    [
      "lease-release-retry",
      "codex-catalog-client-version",
      "codex-catalog-client-version-setup",
    ],
  );
  const [lease, ...codex] = list;
  // The lease release retry window goes from 2 s to 30 s.
  assert.equal(lease.before, "const LEASE_CONTENTION_RETRY_TIMEOUT_MS = 2e3;");
  assert.equal(lease.after, "const LEASE_CONTENTION_RETRY_TIMEOUT_MS = 3e4;");
  // ChatGPT model discovery asks the Codex catalog as client 0.169.0 (GPT-6.2-Astra).
  assert.deepEqual(
    codex.map((patch) => patch.file),
    [
      "dist/base-url-Baro1bPi.mjs",
      "dist/extensions/openai/.setup/provider-policy-api-BhWaBu5H.mjs",
    ],
  );
  for (const patch of codex) {
    assert.equal(patch.before, 'const OPENAI_CODEX_CLIENT_VERSION = "0.164.0";');
    assert.equal(patch.after, 'const OPENAI_CODEX_CLIENT_VERSION = "0.169.0";');
  }
  // No rollback target carries a patch: they install unchanged.
  for (const version of runtimeManifest.rollbackTargets)
    assert.equal(bundlePatchId(version), undefined);
});

test("an installation made before the patch is not the shipped runtime", () => {
  const record = {
    version: runtimeManifest.version,
    nodeVersion: runtimeManifest.nodeVersion,
    dependencyLockSha256: runtimeManifest.dependencyLockSha256,
  };
  assert.equal(shippedRuntime(record), false);
  assert.equal(
    shippedRuntime({ ...record, bundlePatch: bundlePatchId(runtimeManifest.version) }),
    true,
  );
});

test("an install applies the patches of its version and records them", async (t) => {
  const f = assistantInstallFixture(t);
  const fixturePatches = {
    [f.manifest.version]: [
      {
        id: "entry",
        file: "openclaw.mjs",
        before: "fixture entry",
        after: "patched entry",
      },
    ],
  };
  const installed = await ensureAssistantRuntime({
    ...f.options,
    bundlePatches: fixturePatches,
  });
  const id = bundlePatchId(f.manifest.version, fixturePatches);
  assert.equal(installed.bundlePatch, id);
  assert.match(installed.entryPath, new RegExp(`-patch${id}/app/`));
  assert.equal(fs.readFileSync(installed.entryPath, "utf8"), "patched entry");
  const directory = path.resolve(installed.entryPath, "../../../..");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(directory, "receipt.json"))).bundlePatch,
    id,
  );
  // Installed again: the receipt and the patched file are verified, nothing reinstalled.
  const again = await ensureAssistantRuntime({
    ...f.options,
    bundlePatches: fixturePatches,
  });
  assert.equal(again.entryPath, installed.entryPath);
  assert.equal((await selectedAssistantRuntime(f.options)).bundlePatch, id);
});

test("an install whose package does not match its patch is refused", async (t) => {
  const f = assistantInstallFixture(t);
  await assert.rejects(
    ensureAssistantRuntime({
      ...f.options,
      bundlePatches: {
        [f.manifest.version]: [
          { id: "entry", file: "openclaw.mjs", before: "other text", after: "patched" },
        ],
      },
    }),
    { code: "RUNTIME_PATCH_MISMATCH" },
  );
  assert.equal(fs.existsSync(path.join(f.dataDir, "assistants", "runtime.json")), false);
  const runtimes = path.join(f.dataDir, "assistants", "runtimes");
  assert.deepEqual(
    fs.existsSync(runtimes)
      ? fs.readdirSync(runtimes).filter((d) => !d.startsWith("."))
      : [],
    [],
  );
});
