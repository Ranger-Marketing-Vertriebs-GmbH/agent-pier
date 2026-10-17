import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MINIMUM_CLI_VERSIONS,
  atLeast,
  cliVersionStatus,
  createCliVersionProbe,
  withCliVersions,
  parseCliVersion,
  requireCliVersion,
} from "../../server/features/tools/cli-version.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-cli-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function cli(file, version) {
  fs.writeFileSync(file, `#!/bin/sh\necho "${version} (fixture)"\n`, { mode: 0o755 });
}

test("CLI version output is parsed for every supported CLI's format", () => {
  assert.equal(parseCliVersion("codex-cli 0.160.1\n"), "0.160.1");
  assert.equal(parseCliVersion("2.1.296 (Claude Code)\n"), "2.1.296");
  assert.equal(parseCliVersion("1.18.35\n"), "1.18.35");
  assert.equal(parseCliVersion("v1.18.35\n"), "1.18.35");
  assert.equal(parseCliVersion("opencode v1.18.35"), "1.18.35");
  // A prerelease of a version counts as that version.
  assert.equal(parseCliVersion("2.1.263-beta.1"), "2.1.263");
  assert.equal(parseCliVersion("1.2.3.4"), "1.2.3");
  for (const output of ["", "unknown", "v2", null, undefined, 42])
    assert.equal(parseCliVersion(output), null);
});

test("version comparison is numeric per component and rejects unparseable input", () => {
  assert.equal(atLeast("2.1.193", "2.1.193"), true);
  assert.equal(atLeast("2.1.1000", "2.1.193"), true);
  assert.equal(atLeast("2.2.0", "2.1.193"), true);
  assert.equal(atLeast("10.0.0", "9.99.99"), true);
  assert.equal(atLeast("2.1.192", "2.1.193"), false);
  assert.equal(atLeast("1.99.999", "2.0.0"), false);
  assert.equal(atLeast("", "2.1.193"), false);
  assert.equal(atLeast("unknown", "2.1.193"), false);
});

test("every coding CLI has one minimum version and the shell has none", () => {
  assert.deepEqual(Object.keys(MINIMUM_CLI_VERSIONS).sort(), [
    "claude",
    "codex",
    "opencode",
  ]);
  for (const version of Object.values(MINIMUM_CLI_VERSIONS))
    assert.equal(parseCliVersion(version), version);
  assert.equal(cliVersionStatus("shell", "5.9.0").minimumVersion, null);
});

test("the probe caches a version until the binary's mtime or size changes", async (t) => {
  const root = directory(t);
  const file = path.join(root, "claude");
  cli(file, "2.1.263");
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  const calls = [];
  const probe = createCliVersionProbe({
    run: async (command, args) => {
      calls.push([command, args]);
      return fs.readFileSync(file, "utf8").match(/echo "([^"]+)"/)[1];
    },
  });
  assert.equal(await probe.read(file), "2.1.263");
  assert.equal(await probe.read(file), "2.1.263");
  assert.deepEqual(calls, [[file, ["--version"]]]);

  // Same size, new modification time.
  cli(file, "2.1.264");
  fs.utimesSync(file, 1_700_000_100, 1_700_000_100);
  assert.equal(await probe.read(file), "2.1.264");
  assert.equal(calls.length, 2);

  // Different size, modification time restored to the cached one.
  cli(file, "2.1.1000");
  fs.utimesSync(file, 1_700_000_100, 1_700_000_100);
  assert.equal(fs.statSync(file).mtimeMs, 1_700_000_100_000);
  assert.equal(await probe.read(file), "2.1.1000");
  assert.equal(calls.length, 3);
  assert.equal(await probe.read(file), "2.1.1000");
  assert.equal(calls.length, 3);
});

test("the probe follows a replaced symlink to the new binary", async (t) => {
  const root = directory(t);
  const link = path.join(root, "codex");
  cli(path.join(root, "codex-old"), "0.153.4");
  cli(path.join(root, "codex-new"), "0.160.1");
  fs.symlinkSync(path.join(root, "codex-old"), link);
  const probe = createCliVersionProbe();
  assert.equal(await probe.read(link), "0.153.4");
  fs.rmSync(link);
  fs.symlinkSync(path.join(root, "codex-new"), link);
  assert.equal(await probe.read(link), "0.160.1");
});

test("the probe runs the real --version asynchronously and survives broken CLIs", async (t) => {
  const root = directory(t);
  const good = path.join(root, "opencode");
  cli(good, "1.18.35");
  const silent = path.join(root, "silent");
  fs.writeFileSync(silent, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const hanging = path.join(root, "hanging");
  fs.writeFileSync(hanging, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const probe = createCliVersionProbe();
  const pending = probe.read(good);
  assert.equal(typeof pending.then, "function");
  assert.equal(await pending, "1.18.35");
  assert.equal(await probe.read(silent), null);
  assert.equal(await probe.read(path.join(root, "missing")), null);
  const started = Date.now();
  assert.equal(await createCliVersionProbe({ timeout: 300 }).read(hanging), null);
  assert.ok(Date.now() - started < 5000);
});

test("a managed CLI below its minimum is refused with a typed update_required problem", async () => {
  const probe = { read: async () => "2.1.100" };
  const refused = requireCliVersion("claude", "/opt/claude", { probe, managed: true });
  await assert.rejects(refused, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "CLI_UPDATE_REQUIRED");
    assert.deepEqual(error.updateRequired, {
      tool: "claude",
      found: "2.1.100",
      required: MINIMUM_CLI_VERSIONS.claude,
    });
    assert.equal(
      error.message,
      serverMessages.tools.cliUpdateRequired(
        "Claude Code",
        "2.1.100",
        MINIMUM_CLI_VERSIONS.claude,
      ),
    );
    return true;
  });
  // AgentPier cannot update an external installation, so it only warns.
  assert.deepEqual(
    await requireCliVersion("claude", "/opt/claude", { probe, managed: false }),
    {
      version: "2.1.100",
      minimumVersion: MINIMUM_CLI_VERSIONS.claude,
      versionStatus: "update-required",
    },
  );
});

test("an unknown version warns without blocking, a current one passes", async () => {
  assert.deepEqual(
    await requireCliVersion("codex", "/opt/codex", { probe: { read: async () => null } }),
    {
      version: null,
      minimumVersion: MINIMUM_CLI_VERSIONS.codex,
      versionStatus: "unknown",
    },
  );
  assert.equal(
    (await requireCliVersion("codex", "/opt/codex", { version: "0.160.1" }))
      .versionStatus,
    "ok",
  );
  assert.equal(cliVersionStatus("opencode", "1.0.0").versionStatus, "update-required");
});

test("a failed probe is cached for the same binary and retried after it changes", async (t) => {
  const root = directory(t);
  const file = path.join(root, "codex");
  fs.writeFileSync(file, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  let calls = 0;
  const probe = createCliVersionProbe({
    run: async () => {
      calls++;
      return fs.readFileSync(file, "utf8").includes("echo") ? "codex-cli 0.160.1" : null;
    },
  });
  assert.equal(await probe.read(file), null);
  assert.equal(await probe.read(file), null);
  assert.equal(calls, 1);
  // An explicit retry runs it again even though the failure is cached.
  assert.equal(await probe.read(file, { refresh: true, timeout: 50 }), null);
  assert.equal(calls, 2);
  cli(file, "codex-cli 0.160.1");
  assert.equal(await probe.read(file), "0.160.1");
  assert.equal(calls, 3);
});

test("concurrent probes of one binary share a single --version run", async (t) => {
  const root = directory(t);
  const file = path.join(root, "claude");
  cli(file, "2.1.296");
  let calls = 0,
    finish;
  const probe = createCliVersionProbe({
    run: () => {
      calls++;
      return new Promise((resolve) => {
        finish = () => resolve("2.1.296");
      });
    },
  });
  const first = probe.read(file),
    second = probe.read(file);
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish();
  assert.deepEqual(await Promise.all([first, second]), ["2.1.296", "2.1.296"]);
  assert.equal(calls, 1);
});

test("the tool list never waits for a probe in flight", async (t) => {
  const root = directory(t);
  const file = path.join(root, "codex");
  cli(file, "codex-cli 0.160.1");
  let finish;
  const probe = createCliVersionProbe({
    run: () =>
      new Promise((resolve) => {
        finish = () => resolve("codex-cli 0.160.1");
      }),
  });
  const tool = { id: "codex", installed: true, path: file };
  const started = Date.now();
  const [checking] = await withCliVersions([tool], { probe });
  assert.ok(Date.now() - started < 1000);
  assert.equal(checking.versionStatus, "checking");
  assert.equal(checking.version, null);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [known] = await withCliVersions([tool], { probe });
  assert.equal(known.versionStatus, "ok");
  assert.equal(known.version, "0.160.1");
});
