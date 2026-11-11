import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliDriver } from "../../server/features/clis/drivers.js";
import { executablePackageGrants } from "../../server/features/clis/codex/sandbox.js";
import { prepareRequests } from "../../server/features/clis/codex/requests.js";

const linux = { platform: "linux", exists: () => false };

/** A package folder as Codex's installers lay it out, with its executable. */
function writePackage(root, entrypoint = "bin/codex") {
  const executable = path.join(root, entrypoint);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(root, "codex-package.json"),
    JSON.stringify({ layoutVersion: 1, entrypoint }),
  );
  return executable;
}

/** Codex's standalone install: `~/.local/bin/codex` links into `~/.codex/packages`. */
function standalone(t) {
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/apcp-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const packages = path.join(home, ".codex/packages/standalone");
  const release = path.join(packages, "releases/1.0.0-aarch64-apple-darwin");
  writePackage(release);
  fs.symlinkSync(release, path.join(packages, "current"), "dir");
  const command = path.join(home, ".local/bin/codex");
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.symlinkSync(path.join(packages, "current/bin/codex"), command);
  fs.writeFileSync(path.join(home, ".codex/auth.json"), "{}");
  return { base, home, release, command, env: { HOME: home } };
}

test("a standalone Codex install grants the release folder its executable lies in", (t) => {
  const { home, release, command, env } = standalone(t);
  assert.deepEqual(executablePackageGrants(command, env), [
    { access: "read", path: release },
  ]);
  // A managed account names its own CODEX_HOME; the package is still the CLI's.
  const managed = { ...env, CODEX_HOME: path.join(home, "profiles/one/codex") };
  assert.deepEqual(executablePackageGrants(command, managed), [
    { access: "read", path: release },
  ]);
  // Neither the profile nor the folder of all releases.
  assert.notEqual(release, path.join(home, ".codex"));
});

test("an executable outside a Codex package grants nothing", (t) => {
  const { base, env } = standalone(t);
  // Homebrew and npm name a binary or a script without a package file above it.
  const plain = path.join(base, "opt/bin/codex");
  fs.mkdirSync(path.dirname(plain), { recursive: true });
  fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o755 });
  assert.deepEqual(executablePackageGrants(plain, env), []);
  assert.deepEqual(executablePackageGrants(path.join(base, "missing"), env), []);
  assert.deepEqual(executablePackageGrants("codex", env), []);
  assert.deepEqual(executablePackageGrants(undefined, env), []);
  // A package file that names another executable is not this one's package.
  const other = path.join(base, "other");
  const executable = writePackage(other, "bin/codex");
  fs.writeFileSync(
    path.join(other, "codex-package.json"),
    JSON.stringify({ entrypoint: "bin/else" }),
  );
  assert.deepEqual(executablePackageGrants(executable, env), []);
  fs.writeFileSync(path.join(other, "codex-package.json"), "not json");
  assert.deepEqual(executablePackageGrants(executable, env), []);
  // The package file lies too far above the executable to be its package.
  const deep = path.join(base, "deep");
  assert.deepEqual(
    executablePackageGrants(writePackage(deep, "a/b/c/d/e/codex"), env),
    [],
  );
});

test("a package folder that is or holds a Codex profile is never granted", (t) => {
  const { base, home, env } = standalone(t);
  // The profile itself.
  const profile = path.join(home, ".codex");
  assert.deepEqual(executablePackageGrants(writePackage(profile), env), []);
  // A folder above the profile.
  assert.deepEqual(
    executablePackageGrants(writePackage(home, ".codex/bin/codex"), env),
    [],
  );
  // A managed account's own folder.
  const account = path.join(base, "profiles/one/codex");
  assert.deepEqual(
    executablePackageGrants(writePackage(account), { ...env, CODEX_HOME: account }),
    [],
  );
  // A folder that looks like a profile, wherever it lies.
  for (const entry of ["auth.json", "history.jsonl", "sessions"]) {
    const root = path.join(base, `looks-like-${entry}`);
    const executable = writePackage(root);
    assert.equal(executablePackageGrants(executable, env).length, 1);
    if (entry === "sessions") fs.mkdirSync(path.join(root, entry));
    else fs.writeFileSync(path.join(root, entry), "");
    assert.deepEqual(executablePackageGrants(executable, env), []);
  }
});

test("a sandboxed Codex launch carries the package grant, with and without the wrapper", async (t) => {
  const { release, command, env } = standalone(t);
  const grant = { access: "read", path: release };
  // A launch that runs Codex itself (a login, a headless run).
  const direct = cliDriver("codex").sandboxLaunch({ command, args: [], env }, linux);
  assert.deepEqual(direct.sandboxGrants, [grant]);
  // A session runs the wrapper; its executable is declared where it is still known.
  const grants = [];
  const wrapped = await prepareRequests(
    { file: "/x/launch.json", args: [], env: { ...env }, grants },
    { command, args: [], env },
  );
  assert.equal(wrapped.command, process.execPath);
  assert.deepEqual(grants.slice(0, 2), [{ access: "read", path: command }, grant]);
  // The wrapper's interpreter is no Codex package.
  assert.equal(cliDriver("codex").sandboxLaunch(wrapped, linux).sandboxGrants, undefined);
});
