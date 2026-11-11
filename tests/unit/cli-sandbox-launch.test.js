import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliDriver } from "../../server/features/clis/drivers.js";
import {
  SYSTEM_CA_BUNDLE,
  sandboxLaunch as codexSandboxLaunch,
} from "../../server/features/clis/codex/sandbox.js";
import {
  sandboxLaunch as claudeSandboxLaunch,
  socketDirectories,
} from "../../server/features/clis/claude/sandbox.js";
import { NonoSandbox } from "../../server/features/nono/nono-launch.js";
import { cleanEnvironment } from "../../server/features/accounts/account-store.js";

const mac = { platform: "darwin", exists: () => true };
const flagValues = (args, flag) =>
  args.flatMap((value, index) => (args[index - 1] === flag ? [value] : []));

test("a sandboxed Codex on macOS reads its CA roots from the system bundle file", () => {
  const launch = { command: "/bin/codex", args: [], env: { PATH: "/bin" } };
  const prepared = codexSandboxLaunch(launch, mac);
  assert.equal(prepared.env.SSL_CERT_FILE, SYSTEM_CA_BUNDLE);
  assert.equal(SYSTEM_CA_BUNDLE, "/etc/ssl/cert.pem");
  assert.deepEqual(prepared.sandboxGrants, [{ access: "read", path: SYSTEM_CA_BUNDLE }]);
  // The launch handed in is not changed.
  assert.equal(launch.env.SSL_CERT_FILE, undefined);
});

test("the operator's own CA settings stay as they are, and their file is readable", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/apcs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, "corp-ca.pem");
  fs.writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\n");
  for (const platform of ["darwin", "linux"])
    for (const name of ["SSL_CERT_FILE", "CODEX_CA_CERTIFICATE"]) {
      const launch = { command: "/bin/codex", env: { [name]: bundle } };
      const prepared = codexSandboxLaunch(launch, { platform });
      // Nothing of AgentPier's own is set beside the operator's choice.
      assert.deepEqual(prepared.env, launch.env, name);
      assert.deepEqual(prepared.sandboxGrants, [{ access: "read", path: bundle }], name);
    }
  // Both set: both files, each once.
  const other = path.join(root, "other.pem");
  fs.writeFileSync(other, "");
  assert.deepEqual(
    codexSandboxLaunch(
      {
        command: "/bin/codex",
        env: { SSL_CERT_FILE: other, CODEX_CA_CERTIFICATE: bundle },
      },
      mac,
    ).sandboxGrants,
    [
      { access: "read", path: other },
      { access: "read", path: bundle },
    ],
  );
  // A value that names no file of its own is left to Codex: nothing is granted.
  for (const value of ["/corp/missing.pem", "relative.pem", root, "/dev/null"]) {
    const launch = { command: "/bin/codex", env: { CODEX_CA_CERTIFICATE: value } };
    assert.equal(codexSandboxLaunch(launch, mac), launch, value);
  }
});

test("the server's CODEX_CA_CERTIFICATE reaches the sessions like its SSL_CERT_FILE", () => {
  const env = cleanEnvironment({
    PATH: "/bin",
    HOME: "/home/example",
    SSL_CERT_FILE: "/corp/roots.pem",
    CODEX_CA_CERTIFICATE: "/corp/codex.pem",
    CODEX_HOME: "/elsewhere",
  });
  assert.equal(env.SSL_CERT_FILE, "/corp/roots.pem");
  assert.equal(env.CODEX_CA_CERTIFICATE, "/corp/codex.pem");
  assert.equal(env.CODEX_HOME, undefined);
});

test("Codex keeps its launch where the bundle is missing or the host is not macOS", () => {
  const launch = { command: "/bin/codex", env: {} };
  assert.equal(codexSandboxLaunch(launch, { ...mac, exists: () => false }), launch);
  assert.equal(codexSandboxLaunch(launch, { ...mac, platform: "linux" }), launch);
});

test("Claude Code's socket folder is resolved the way the CLI resolves it", () => {
  assert.deepEqual(socketDirectories({}, 501), ["/tmp/cc-socks"]);
  assert.deepEqual(socketDirectories({ CLAUDE_CODE_TMPDIR: "/x/t" }, 501), [
    "/x/t/cc-socks",
  ]);
  assert.deepEqual(
    socketDirectories(
      { XDG_RUNTIME_DIR: "/run/user/501", CLAUDE_CODE_TMPDIR: "/x" },
      501,
    ),
    ["/run/user/501/cc-socks"],
  );
  // Too long for a socket address: the CLI falls back to a per-user folder in /tmp.
  const long = `/${"d".repeat(90)}`;
  assert.deepEqual(socketDirectories({ CLAUDE_CODE_TMPDIR: long }, 501), [
    `${long}/cc-socks`,
    "/tmp/cc-socks-501",
  ]);
});

test("a sandboxed Claude Code gets its socket folder created and granted", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/apcs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launch = { command: "/bin/claude", env: { CLAUDE_CODE_TMPDIR: root } };
  const prepared = claudeSandboxLaunch(launch);
  const directory = path.join(root, "cc-socks");
  assert.deepEqual(prepared.sandboxGrants, [
    { access: "socket-dir-bind", path: directory },
  ]);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(launch.sandboxGrants, undefined);
});

test("a socket folder that is not the server user's is not granted", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/apcs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launch = { command: "/bin/claude", env: { CLAUDE_CODE_TMPDIR: root } };
  assert.equal(claudeSandboxLaunch(launch, { uid: process.getuid() + 1 }), launch);
  // A file in the way cannot become the folder either.
  const blocked = path.join(root, "blocked");
  fs.writeFileSync(blocked, "");
  const other = { command: "/bin/claude", env: { CLAUDE_CODE_TMPDIR: blocked } };
  assert.equal(claudeSandboxLaunch(other), other);
});

test("the drivers expose what each CLI needs in a sandbox", () => {
  assert.equal(typeof cliDriver("codex").sandboxLaunch, "function");
  assert.equal(typeof cliDriver("claude").sandboxLaunch, "function");
  assert.equal(typeof cliDriver("opencode").sandboxLaunch, "function");
});

test("the nono adapter applies the CLI's needs to a sandboxed launch only", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/apcs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandbox = new NonoSandbox({
    detect: () => [{ id: "nono", installed: true, path: "/bin/nono" }],
    readProfiles: async () => ["dev"],
  });
  const launch = {
    command: "/bin/claude",
    args: ["--resume"],
    env: { CLAUDE_CODE_TMPDIR: root },
  };
  const wrapped = await sandbox.prepare({ launch, profile: "dev", tool: "claude" });
  assert.deepEqual(flagValues(wrapped.args, "--allow-unix-socket-dir-bind"), [
    path.join(root, "cc-socks"),
  ]);
  assert.deepEqual(wrapped.args.slice(-2), ["/bin/claude", "--resume"]);
  // The shell and a launch without a tool keep the launch they came with.
  for (const tool of ["shell", undefined]) {
    const other = await sandbox.prepare({ launch, profile: "dev", tool });
    assert.deepEqual(flagValues(other.args, "--allow-unix-socket-dir-bind"), []);
  }
  // Without a sandbox nothing is created or added.
  const plain = { command: "/bin/claude", args: [], env: { CLAUDE_CODE_TMPDIR: "/x" } };
  const untouched = await sandbox.prepare({
    launch: plain,
    profile: null,
    tool: "claude",
  });
  assert.deepEqual(untouched, plain);
  assert.equal(fs.existsSync("/x/cc-socks"), false);
});

test("the nono adapter hands a sandboxed Codex launch the CA file", async () => {
  const seen = [];
  const sandbox = new NonoSandbox({
    detect: () => [{ id: "nono", installed: true, path: "/bin/nono" }],
    readProfiles: async () => ["dev"],
    prepareCli: (tool, launch) => {
      seen.push(tool);
      return cliDriver(tool).sandboxLaunch(launch, mac);
    },
  });
  const launch = { command: "/bin/codex", args: [], env: { PATH: "/bin" } };
  const wrapped = await sandbox.prepare({ launch, profile: "dev", tool: "codex" });
  assert.deepEqual(seen, ["codex"]);
  assert.equal(wrapped.env.SSL_CERT_FILE, SYSTEM_CA_BUNDLE);
  assert.ok(flagValues(wrapped.args, "--read-file").includes(SYSTEM_CA_BUNDLE));
  const plain = await sandbox.prepare({ launch, profile: null, tool: "codex" });
  assert.equal(plain.env.SSL_CERT_FILE, undefined);
});

/** A managed Claude account folder whose asset folders link to the CLI's own profile. */
function sharedProfile(t) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/apcs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const config = path.join(root, "profiles/one/claude");
  fs.mkdirSync(config, { recursive: true });
  for (const name of ["agents", "commands", "plugins", "skills"]) {
    fs.mkdirSync(path.join(home, ".claude", name), { recursive: true });
    fs.symlinkSync(path.join(home, ".claude", name), path.join(config, name), "dir");
  }
  const env = { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: root };
  const own = (launch) =>
    (launch.sandboxGrants || []).filter((grant) => grant.access !== "socket-dir-bind");
  return { root, home, config, env, own };
}

test("a sandboxed managed Claude account reads the folders linked to the CLI's own profile", (t) => {
  const { home, env, own } = sharedProfile(t);
  const shared = path.join(home, ".claude");
  const prepared = claudeSandboxLaunch({ command: "/bin/claude", env });
  assert.deepEqual(own(prepared), [
    { access: "read", path: path.join(shared, "agents") },
    { access: "read", path: path.join(shared, "commands") },
    { access: "read", path: path.join(shared, "plugins") },
    // Claude Code creates a data folder per plugin before it runs the plugin's hooks.
    { access: "allow", path: path.join(shared, "plugins/data") },
    { access: "read", path: path.join(shared, "skills") },
  ]);
  assert.equal(fs.statSync(path.join(shared, "plugins/data")).mode & 0o777, 0o700);
  // Never the profile itself, with its settings, history and login.
  assert.equal(
    own(prepared).some((grant) => grant.path === shared),
    false,
  );
});

test("only a link to the CLI's own profile is granted, not wherever a link points", (t) => {
  const { root, home, config, env, own } = sharedProfile(t);
  // A session may write its account folder: a link it re-pointed grants nothing.
  const secret = path.join(root, "secret");
  fs.mkdirSync(secret);
  fs.rmSync(path.join(config, "plugins"));
  fs.symlinkSync(secret, path.join(config, "plugins"), "dir");
  // A folder of the account's own needs no grant beyond the account folder.
  fs.rmSync(path.join(config, "skills"));
  fs.mkdirSync(path.join(config, "skills"));
  fs.rmSync(path.join(config, "agents"));
  assert.deepEqual(own(claudeSandboxLaunch({ command: "/bin/claude", env })), [
    { access: "read", path: path.join(home, ".claude/commands") },
  ]);
  assert.equal(fs.existsSync(path.join(secret, "data")), false);
  // A local account has no account folder: its profile is the operator's to grant.
  const local = { HOME: home, CLAUDE_CODE_TMPDIR: root };
  assert.deepEqual(own(claudeSandboxLaunch({ command: "/bin/claude", env: local })), []);
});
