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
import { assertSupersededPublicationRetried } from "../helpers/superseded-publication-guard.js";

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
      "no-restart-resume",
      "no-restart-resume-inputs",
      "hydrated-tools-kept",
      "hydrated-tools-kept-list",
    ],
  );
  const [lease, resume, inputs] = list;
  // A lease release that met a SQLite lock is retried for 30 s instead of 5 s; the
  // shared contention constant, which the agent execution also reads, stays as is.
  assert.equal(lease.file, "dist/openclaw-state-lease-storage-BBSi-Imk.mjs");
  assert.match(lease.before, /a \? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS : /);
  assert.equal(
    lease.after,
    "const o = n + (a ? 3e4 : LEASE_CONTENTION_RETRY_TIMEOUT_MS);",
  );
  // The startup resume adopts no restart marker and reserves no queued message.
  for (const patch of [resume, inputs])
    assert.equal(patch.file, "dist/session-restart-resume-BzRgzT_h.mjs");
  assert.match(resume.before, /^const r = n\.resumeAfterRestart \?\? \(/);
  assert.doesNotMatch(resume.after, /resumeAfterRestart|mainRestartRecovery/);
  assert.match(inputs.before, /resumeAfterRestart\?\.queuedInputIds/);
  assert.doesNotMatch(inputs.after, /resumeAfterRestart/);
  // The rollback target keeps the patches its installation carries; none is applied
  // or verified again for it here.
  for (const version of runtimeManifest.rollbackTargets)
    assert.equal(bundlePatchId(version), undefined);
});

// The marker read of OpenClaw 2026.11.6's resumeAgentSessions (session-restart-
// resume-BzRgzT_h.mjs) as shipped, inside its applySessionEntryExactReplacements
// update: the patched text must still parse, clear every marker and resume nothing.
const markerSite = (line) => `
const LEGACY_RESTART_RESUME_WINDOW_MS = 216e5;
const canResumeSession = () => true;
export function update(e, t, o) {
\tconst n = e.find((e) => e.sessionKey === t)?.entry;
\tif (!n || !n.resumeAfterRestart && !n.mainRestartRecovery) return { result: void 0 };
\t${line}
\tconst i = {
\t\t...n,
\t\tresumeAfterRestart: canResumeSession(t, n) ? r : void 0,
\t\tmainRestartRecovery: void 0
\t};
\treturn {
\t\tresult: r ? { entry: i, marker: r } : void 0,
\t\treplacements: n.mainRestartRecovery || i.resumeAfterRestart !== n.resumeAfterRestart ? [{ sessionKey: t, entry: i }] : void 0
\t};
}
`;

test("the restart resume patch clears markers without resuming a session", async () => {
  const [, patch] = runtimeBundlePatches[runtimeManifest.version];
  const load = (text) =>
    import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
  const original = await load(markerSite(patch.before));
  const patched = await load(markerSite(patch.after));
  const now = 1_000_000_000;
  const entries = {
    // A graceful shutdown's marker, with a queued message it reserved.
    marked: { sessionId: "s1", resumeAfterRestart: { queuedInputIds: ["q1"] } },
    // A 2026.11.3 main-session recovery marker less than six hours old.
    legacy: {
      sessionId: "s2",
      mainRestartRecovery: { cycleId: "c" },
      abortedLastRun: true,
      status: "interrupted",
      updatedAt: now - 60_000,
    },
  };
  for (const [key, entry] of Object.entries(entries)) {
    const rows = [{ sessionKey: key, entry }];
    // Unpatched, the marker is adopted and the session resumed.
    assert.ok(original.update(rows, key, now).result, key);
    const { result, replacements } = patched.update(rows, key, now);
    assert.equal(result, undefined, key);
    assert.equal(replacements.length, 1, key);
    const [{ entry: cleared }] = replacements;
    assert.equal(cleared.resumeAfterRestart, undefined, key);
    assert.equal(cleared.mainRestartRecovery, undefined, key);
    assert.equal(cleared.sessionId, entry.sessionId, key);
  }
});

test("the restart resume inputs patch withdraws every queued message", () => {
  const [, , patch] = runtimeBundlePatches[runtimeManifest.version];
  const site = (text) => new Function("s", `return ${text};`);
  const summaries = [
    { entry: { resumeAfterRestart: { queuedInputIds: ["q1", "q2"] } } },
    { entry: {} },
  ];
  // Unpatched, a marker's queued messages are spared from the orphan withdrawal.
  assert.deepEqual(site(patch.before)(summaries), ["q1", "q2"]);
  assert.deepEqual(site(patch.after)(summaries), []);
});

// OpenClaw 2026.11.6 fixed what "superseded-publication-retry" patched in 2026.11.3:
// publishAgent turns a superseded model runtime publication into the refusal the
// startup loop retries. The guard fails a package that lost the conversion.
const lifecycleSite =
  "function isPreparedModelRuntimePluginLifecycleFailure(e) {\n" +
  "\treturn e instanceof PluginInstanceUnavailableError || e instanceof PreparedModelRuntimePluginGenerationRetiredError || e instanceof PreparedModelRuntimePublicationSupersededError;\n" +
  "}\n";
const conversionSite =
  "const activation = { publishAgent: async () => { await t().catch(async (e) => {\n" +
  "\tif (!isPreparedModelRuntimePluginLifecycleFailure(e)) throw e;\n" +
  "\tawait l();\n" +
  '\tthrow new AgentDatabaseStartupSupersededError(n, "startup");\n' +
  "}); } };\n";
const loopSite =
  "const STARTUP_PUBLICATION_ATTEMPTS = 4;\n" +
  "for (let e = 1;; e++) try {\n\tawait c.publishAgent(f);\n\tbreak;\n} catch (t) {\n" +
  "\tconst n = t instanceof AgentDatabaseStartupSupersededError || t instanceof AgentDatabaseSchemaAdmissionChangedError;\n" +
  "\tif (!n || e >= STARTUP_PUBLICATION_ATTEMPTS) throw n ? new AgentDatabaseStartupPublicationError(t) : t;\n" +
  "}\n";

test("the superseded publication guard checks upstream's own retry", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superseded-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "dist"));
  const write = (name, text) => fs.writeFileSync(path.join(dir, "dist", name), text);
  write("agent-database-startup-DnP-Ft5D.mjs", loopSite);
  write("prepared-model-runtime-admission-errors-LxrcCg4d.mjs", lifecycleSite);
  // 2026.11.3: publishAgent let the superseded publication escape the loop.
  write("gateway-prewarm.js", "const activation = { publishAgent: async () => t() };\n");
  assert.throws(
    () => assertSupersededPublicationRetried(dir),
    /publishAgent converts no lifecycle failure/,
  );
  write("gateway-prewarm.js", conversionSite);
  assert.deepEqual(assertSupersededPublicationRetried(dir), {
    lifecycle: [
      {
        file: "dist/prepared-model-runtime-admission-errors-LxrcCg4d.mjs",
        superseded: true,
      },
    ],
    conversion: [{ file: "dist/gateway-prewarm.js" }],
    loop: [{ file: "dist/agent-database-startup-DnP-Ft5D.mjs" }],
  });
  // A superseded publication that no longer counts as a lifecycle failure fails.
  write(
    "prepared-model-runtime-admission-errors-LxrcCg4d.mjs",
    lifecycleSite.replace(
      " || e instanceof PreparedModelRuntimePublicationSupersededError",
      "",
    ),
  );
  assert.throws(() => assertSupersededPublicationRetried(dir), /no plugin lifecycle/);
  // So does a package without the loop.
  write("prepared-model-runtime-admission-errors-LxrcCg4d.mjs", lifecycleSite);
  write("agent-database-startup-DnP-Ft5D.mjs", "export {};\n");
  assert.throws(() => assertSupersededPublicationRetried(dir), /no startup publication/);
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
