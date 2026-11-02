import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermesInstallFixture } from "../helpers/hermes-install-fixture.js";
import {
  ensureHermesRuntime,
  hermesIdentity,
  sameHermesRuntime,
  selectedHermesRuntime,
  shippedHermesRuntime,
  stageHermesRuntime,
} from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import {
  hermesManifest,
  uvArchiveUrl,
  validHermesManifest,
} from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";
import {
  hermesAgentPaths,
  hermesPaths,
} from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const root = (f) => path.join(f.dataDir, "assistants", "hermes");

test("the shipped manifest pins a release, its commit and lock, uv per platform and CPython 3.14", () => {
  assert.match(hermesManifest.tag, /^v\d+\.\d+\.\d+$/);
  assert.match(hermesManifest.commit, /^[0-9a-f]{40}$/);
  // A release pin is named after its tag; a bare commit pin after the commit.
  assert.equal(hermesManifest.version, hermesManifest.tag.slice(1));
  const { tag: _tag, ...bare } = hermesManifest;
  assert.throws(() => validHermesManifest(bare), /manifest/);
  assert.equal(
    validHermesManifest({ ...bare, version: bare.commit.slice(0, 12) }).version,
    bare.commit.slice(0, 12),
  );
  assert.match(hermesManifest.pythonVersion, /^3\.14\.\d+$/);
  assert.deepEqual(hermesManifest.extras, ["ddgs", "messaging", "mcp"]);
  assert.deepEqual(Object.keys(hermesManifest.uvChecksums).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ]);
  assert.equal(
    uvArchiveUrl(hermesManifest, "linux-arm64"),
    `https://github.com/astral-sh/uv/releases/download/${hermesManifest.uvVersion}/uv-aarch64-unknown-linux-gnu.tar.gz`,
  );
  for (const broken of [
    { archiveUrl: "https://example.test/hermes.tar.gz" },
    { pythonVersion: "3.13.9" },
    { uvChecksums: { "linux-x64": "0".repeat(64) } },
    { uvLockSha256: "nope" },
    { version: "other" },
    { tag: "main" },
    { tag: "v0.22" },
  ])
    assert.throws(
      () => validHermesManifest({ ...hermesManifest, ...broken }),
      /manifest/,
    );
});

test("an installation verifies both archives and the lock, then selects itself", async (t) => {
  const f = hermesInstallFixture(t);
  const record = await ensureHermesRuntime(f.options);
  const directory = path.join(
    root(f),
    "runtimes",
    hermesIdentity(f.manifest, "linux-x64"),
  );
  assert.equal(record.directory, directory);
  assert.equal(record.pythonPath, path.join(directory, "venv/bin/python"));
  assert.ok(shippedHermesRuntime(record, f.manifest));
  // The same release built without an extra the pin names is due for an update.
  assert.equal(
    shippedHermesRuntime({ ...record, extras: ["messaging"] }, f.manifest),
    false,
  );
  assert.match(record.directory, /-ddgs\+mcp\+messaging$/);
  assert.deepEqual(read(path.join(root(f), "runtime.json")), record);
  assert.equal(fs.existsSync(path.join(root(f), "candidate.json")), false);
  const receipt = read(path.join(directory, "receipt.json"));
  assert.equal(receipt.archiveSha256, f.manifest.archiveSha256);
  assert.equal(receipt.uvLockSha256, f.manifest.uvLockSha256);
  // The wheels' cache and the scratch folders are gone once the receipt exists.
  assert.equal(fs.existsSync(path.join(root(f), "uv-cache")), false);
  assert.deepEqual(fs.readdirSync(path.join(root(f), "tmp")), []);
  // Again: the receipt is verified, nothing is downloaded or run.
  const before = f.calls.length;
  assert.deepEqual(await ensureHermesRuntime(f.options), record);
  assert.equal(f.calls.length, before);
});

test("uv runs locked, offline from host Pythons and inside AgentPier's folder", async (t) => {
  const f = hermesInstallFixture(t);
  const record = await ensureHermesRuntime(f.options);
  const uv = f.calls.filter((call) => call.file?.endsWith("/uv/uv"));
  const install = uv.find((call) => call.args[0] === "python");
  assert.deepEqual(install.args, [
    "python",
    "install",
    "--no-bin",
    f.manifest.pythonVersion,
  ]);
  const sync = uv.find((call) => call.args[0] === "sync");
  assert.deepEqual(sync.args, [
    "sync",
    "--frozen",
    "--no-dev",
    "--extra",
    "ddgs",
    "--extra",
    "messaging",
    "--extra",
    "mcp",
    "--python",
    f.manifest.pythonVersion,
  ]);
  assert.equal(sync.cwd, path.join(record.directory, "src"));
  assert.equal(sync.env.UV_PYTHON_DOWNLOADS, "never");
  for (const { env } of uv) {
    assert.equal(env.UV_NO_CONFIG, "1");
    assert.equal(env.UV_PYTHON_PREFERENCE, "only-managed");
    assert.equal(env.UV_PYTHON_INSTALL_DIR, path.join(record.directory, "python"));
    assert.equal(env.UV_PYTHON_BIN_DIR, path.join(record.directory, "python", "bin"));
    assert.equal(env.UV_PROJECT_ENVIRONMENT, path.join(record.directory, "venv"));
    assert.ok(env.UV_CACHE_DIR.startsWith(root(f) + path.sep));
    assert.ok(env.HOME.startsWith(path.join(root(f), "tmp") + path.sep));
    assert.notEqual(env.HOME, os.homedir());
    // Proxy settings are the only inherited variables.
    assert.equal(env.HTTPS_PROXY, "http://proxy.test:3128");
    assert.equal(env.SECRET, undefined);
  }
  // The identity probe never sees the owner's ~/.hermes.
  const probe = f.calls.find((call) => call.file?.endsWith("/venv/bin/python"));
  assert.ok(probe.env.HERMES_HOME.startsWith(path.join(root(f), "tmp") + path.sep));
});

test("a changed archive, lock or version refuses the installation and leaves nothing", async (t) => {
  for (const [label, change, code] of [
    [
      "uv",
      (f) => f.tamper(uvArchiveUrl(f.manifest, "linux-x64"), Buffer.from("x")),
      "HERMES_CHECKSUM_MISMATCH",
    ],
    [
      "source",
      (f) => f.tamper(f.manifest.archiveUrl, Buffer.from("x")),
      "HERMES_CHECKSUM_MISMATCH",
    ],
    [
      "version",
      (f) => (f.probe = { releaseDate: "1999.1.1", python: "3.14.10" }),
      "HERMES_VERSION_MISMATCH",
    ],
  ]) {
    const f = hermesInstallFixture(t);
    change(f);
    await assert.rejects(ensureHermesRuntime(f.options), { code }, label);
    assert.deepEqual(fs.readdirSync(path.join(root(f), "runtimes")), [], label);
    assert.equal(fs.existsSync(path.join(root(f), "runtime.json")), false, label);
  }
  const f = hermesInstallFixture(t);
  await assert.rejects(
    ensureHermesRuntime({
      ...f.options,
      manifest: { ...f.manifest, uvLockSha256: "0".repeat(64) },
    }),
    { code: "HERMES_LOCK_MISMATCH" },
  );
  await assert.rejects(ensureHermesRuntime({ ...f.options, platform: "win32" }), {
    code: "HERMES_PLATFORM_UNSUPPORTED",
  });
});

test("a crashed attempt without a receipt is replaced, a changed receipt refused", async (t) => {
  const f = hermesInstallFixture(t);
  const directory = path.join(
    root(f),
    "runtimes",
    hermesIdentity(f.manifest, "linux-x64"),
  );
  fs.mkdirSync(path.join(directory, "venv"), { recursive: true });
  fs.writeFileSync(path.join(directory, "venv", "leftover"), "x");
  const record = await ensureHermesRuntime(f.options);
  assert.equal(fs.existsSync(path.join(directory, "venv", "leftover")), false);
  fs.writeFileSync(path.join(directory, "src", "uv.lock"), "changed");
  await assert.rejects(stageHermesRuntime(f.options), {
    code: "HERMES_CHECKSUM_MISMATCH",
  });
  await assert.rejects(selectedHermesRuntime(f.options), {
    code: "HERMES_CHECKSUM_MISMATCH",
  });
  assert.ok(sameHermesRuntime(record, read(path.join(root(f), "runtime.json"))));
});

test("a newer pin is staged as the candidate beside the selected installation", async (t) => {
  const f = hermesInstallFixture(t);
  const first = await ensureHermesRuntime(f.options);
  const next = hermesInstallFixture(t, {
    releaseDate: "2026.10.1",
    commit: "c".repeat(40),
  });
  // The second fixture's archives, installed into the first data directory.
  const staged = await stageHermesRuntime({ ...next.options, dataDir: f.dataDir });
  assert.notEqual(staged.directory, first.directory);
  assert.deepEqual(read(path.join(root(f), "runtime.json")), first);
  assert.deepEqual(read(path.join(root(f), "candidate.json")), staged);
  // A concurrent second call joins the running job.
  const again = hermesInstallFixture(t);
  const [a, b] = [stageHermesRuntime(again.options), stageHermesRuntime(again.options)];
  assert.equal(a, b);
  await a;
});

test("a selection outside the runtime folder is refused; a removed one reinstalled", async (t) => {
  const f = hermesInstallFixture(t);
  const record = await ensureHermesRuntime(f.options);
  const file = path.join(root(f), "runtime.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ ...record, directory: "/usr", pythonPath: "/usr/bin/python3" }),
  );
  await assert.rejects(selectedHermesRuntime(f.options), {
    code: "HERMES_SELECTION_UNSAFE",
  });
  fs.writeFileSync(file, JSON.stringify(record));
  assert.deepEqual(await selectedHermesRuntime(f.options), record);
  fs.rmSync(record.directory, { recursive: true });
  const reinstalled = await selectedHermesRuntime(f.options);
  assert.equal(reinstalled.diagnostic, "RUNTIME_REINSTALLED");
  assert.ok(fs.existsSync(path.join(record.directory, "receipt.json")));
});

test("agent folders are private and named only by safe ids", (t) => {
  const f = hermesInstallFixture(t);
  const paths = hermesPaths(f.dataDir);
  const agent = hermesAgentPaths(paths, "agent-1");
  assert.equal(agent.hermesHome, path.join(paths.state, "agent-1"));
  assert.equal(agent.home, path.join(paths.home, "agent-1"));
  for (const folder of Object.values(agent))
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  for (const id of ["../x", "", "a/b", ".hidden", "x".repeat(65)])
    assert.throws(() => hermesAgentPaths(paths, id), { code: "HERMES_AGENT_ID" });
});
