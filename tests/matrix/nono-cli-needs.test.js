// test-runner-timeout-ms: 300000
// Starts real sandboxes and child processes: its own timeout class under load
// (scripts/test-runner.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  wrapWithNono,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { cliDriver } from "../../server/features/clis/drivers.js";
import { installShim } from "../../server/features/accounts/managed-logins.js";

/**
 * What a coding CLI itself needs inside a sandbox (`<id>/sandbox.js`, the login
 * stand-in), run through a real nono: the unit tests pin the flags, this file asks
 * the kernel. Skipped without the binary, like nono-confinement.test.js.
 */
function nonoExecutable() {
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean))
    try {
      const candidate = path.join(directory, "nono");
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  return null;
}
const executable = nonoExecutable();
const reason = !executable
  ? "nono is not installed"
  : !["darwin", "linux"].includes(process.platform)
    ? `nono does not support ${process.platform}`
    : null;
const options = reason ? { skip: reason } : {};
const macOnly =
  reason || process.platform === "darwin" ? options : { skip: "macOS trust store only" };

// Grants nothing of its own beyond what lets a binary start. On macOS it also drops
// the group that makes the shared temporary folder writable, like a tight profile of
// an operator, so a socket can only be bound where AgentPier granted it.
const restrictive = {
  meta: { name: "agentpier-cli-needs" },
  groups: {
    include: ["system_read_macos", "system_read_linux_core"],
    exclude: process.platform === "darwin" ? ["system_write_macos"] : [],
  },
  workdir: { access: "readwrite" },
  filesystem: { allow: [], read: [], write: [], deny: [] },
  network: { block: false },
};

// Outside every grant AgentPier composes (see nono-confinement.test.js).
function workspace(t) {
  const scratch = path.join(INSTALLATION_ROOT, ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "nono-cli-needs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "work"));
  const profile = path.join(root, "profile.json");
  fs.writeFileSync(profile, JSON.stringify(restrictive));
  return { root, profile, cwd: path.join(root, "work") };
}

function run({ launch, profile, cwd }) {
  const wrapped = wrapWithNono({ launch, executable, profile });
  try {
    return execFileSync(wrapped.command, ["wrap", "-s", ...wrapped.args.slice(1)], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, NONO_THEME: "minimal", ...(wrapped.env || {}) },
    });
  } catch (error) {
    return `${error.stdout || ""}${error.stderr || ""}`;
  }
}

const bindScript = `
const net = require("node:net"), path = require("node:path");
const file = path.join(process.argv[1], process.pid + ".sock");
const server = net.createServer();
server.once("error", (error) => console.log("BIND:" + error.code));
server.listen(file, () => { console.log("BIND:ok"); server.close(); });
`;

test(
  "a sandboxed Claude Code may bind its socket only with the folder AgentPier grants",
  options,
  (t) => {
    const { profile, cwd } = workspace(t);
    // Short, like the /tmp the CLI uses: a socket address holds about 100 bytes.
    const temporary = fs.realpathSync(fs.mkdtempSync("/tmp/apcn-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const directory = path.join(temporary, "cc-socks");
    const launch = {
      command: process.execPath,
      args: ["-e", bindScript, directory],
      env: { CLAUDE_CODE_TMPDIR: temporary },
    };
    const prepared = cliDriver("claude").sandboxLaunch(launch);
    assert.deepEqual(prepared.sandboxGrants, [
      { access: "socket-dir-bind", path: directory },
    ]);
    assert.match(run({ launch: prepared, profile, cwd }), /BIND:ok/);
    // The control: the same folder, already created, without the grant.
    if (process.platform === "darwin")
      assert.match(run({ launch, profile, cwd }), /BIND:E(PERM|ACCES)/);
  },
);

test(
  "a sandboxed session runs the login stand-in from the folder AgentPier grants",
  options,
  (t) => {
    const { root, profile, cwd } = workspace(t);
    const real = path.join(root, "real-security");
    fs.writeFileSync(real, "#!/bin/sh\necho REAL\nexit 0\n", { mode: 0o700 });
    const shim = installShim(
      path.join(root, "shim"),
      cliDriver("claude").loginStore.shim,
      real,
    );
    const launch = {
      command: "/bin/sh",
      args: [
        "-c",
        'security find-generic-password -a me -w -s "Claude Code-credentials-0a1b2c3d" 2>&1; echo "EXIT:$?"',
      ],
      env: { PATH: `${shim}:/usr/bin:/bin` },
    };
    const granted = run({
      launch: { ...launch, sandboxGrants: [{ access: "read", path: shim }] },
      profile,
      cwd,
    });
    assert.match(granted, /could not be found in the keychain/);
    assert.match(granted, /EXIT:44/);
    assert.doesNotMatch(granted, /REAL/);
    // Without the grant the stand-in cannot run, and the answer is not "not found".
    assert.doesNotMatch(run({ launch, profile, cwd }), /EXIT:44/);
  },
);

test("a sandboxed Codex can read the CA bundle its launch names", macOnly, (t) => {
  const { profile, cwd } = workspace(t);
  const launch = cliDriver("codex").sandboxLaunch({
    command: "/bin/sh",
    args: ["-c", 'grep -c "BEGIN CERTIFICATE" "$SSL_CERT_FILE"'],
    env: { PATH: "/usr/bin:/bin" },
  });
  assert.equal(launch.env.SSL_CERT_FILE, "/etc/ssl/cert.pem");
  const output = run({ launch, profile, cwd });
  assert.ok(Number(output.trim().split("\n").at(-1)) > 10, output);
});

test(
  "a sandboxed managed Claude account reaches the linked plugin folder and no more of the profile",
  options,
  (t) => {
    const { root, profile, cwd } = workspace(t);
    const home = path.join(root, "home");
    const shared = path.join(home, ".claude");
    const config = path.join(root, "profiles/one/claude");
    fs.mkdirSync(config, { recursive: true });
    for (const name of ["agents", "commands", "plugins", "skills"]) {
      fs.mkdirSync(path.join(shared, name), { recursive: true });
      fs.symlinkSync(path.join(shared, name), path.join(config, name), "dir");
    }
    fs.writeFileSync(path.join(shared, "plugins/installed_plugins.json"), "INSTALLED");
    fs.writeFileSync(path.join(shared, "skills/skill.md"), "SKILL");
    fs.writeFileSync(path.join(shared, "settings.json"), "SETTINGS");
    const script = [
      // What Claude Code does before it runs a plugin's hook.
      'echo "DATA:$(mkdir -p "$CLAUDE_CONFIG_DIR/plugins/data/agentpier-reader-inline" 2>&1 && echo made)"',
      'echo "INSTALLED:$(cat "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json" 2>&1)"',
      'echo "SKILL:$(cat "$CLAUDE_CONFIG_DIR/skills/skill.md" 2>&1)"',
      'echo "PLANT:$( (echo x > "$CLAUDE_CONFIG_DIR/plugins/planted") 2>&1 && echo written)"',
      'echo "PROFILE:$(cat "$HOME/.claude/settings.json" 2>&1)"',
    ].join("\n");
    const launch = {
      command: "/bin/sh",
      args: ["-c", script],
      env: { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: root },
      // The account's own folder, as the account store grants it.
      sandboxGrants: [{ access: "allow", path: path.dirname(config) }],
    };
    const granted = run({
      launch: cliDriver("claude").sandboxLaunch(launch),
      profile,
      cwd,
    });
    assert.match(granted, /DATA:made/);
    assert.match(granted, /INSTALLED:INSTALLED/);
    assert.match(granted, /SKILL:SKILL/);
    assert.match(granted, /PLANT:.*(not permitted|denied)/i);
    assert.match(granted, /PROFILE:.*(not permitted|denied)/i);
    assert.equal(fs.existsSync(path.join(shared, "plugins/planted")), false);
    // The control: without the grants the hook's data folder cannot be made.
    fs.rmSync(path.join(shared, "plugins/data"), { recursive: true });
    const plain = run({ launch, profile, cwd });
    assert.match(plain, /DATA:.*(not permitted|denied)/i);
    assert.match(plain, /INSTALLED:.*(not permitted|denied)/i);
  },
);

test(
  "a sandboxed session runs the hook dispatcher of a release activated after it started",
  options,
  (t) => {
    const { root, profile, cwd } = workspace(t);
    // An install root: the session started from 1.0.0, an update activated 2.0.0.
    const releases = path.join(root, "app/releases");
    const active = path.join(releases, "2.0.0");
    fs.mkdirSync(path.join(releases, "1.0.0"), { recursive: true });
    fs.mkdirSync(path.join(active, "bin"), { recursive: true });
    fs.mkdirSync(path.join(active, "server"));
    fs.writeFileSync(path.join(active, "server/claude-hook.js"), "HOOK-OF-2.0.0\n");
    // Stands in for the release's own Node: a program inside the release.
    fs.writeFileSync(path.join(active, "bin/node"), '#!/bin/sh\ncat "$1"\n', {
      mode: 0o755,
    });
    // What the server of 2.0.0 writes at its start (requests/claude-runtime.js).
    const runtime = path.join(root, "data/request-runtime");
    fs.mkdirSync(runtime, { recursive: true });
    const dispatcher = path.join(runtime, "claude-hook.sh");
    fs.writeFileSync(
      dispatcher,
      `#!/bin/sh\nexec '${path.join(active, "bin/node")}' '${path.join(active, "server/claude-hook.js")}' "$@"\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(path.join(root, "app/secret"), "SECRET");
    const launch = {
      command: "/bin/sh",
      args: [
        "-c",
        `echo "HOOK:$(/bin/sh '${dispatcher}' 2>&1)"; echo "ROOT:$(cat '${path.join(root, "app/secret")}' 2>&1)"`,
      ],
      sandboxGrants: [{ access: "read", path: runtime }],
    };
    const wrap = (releasesGrant) => {
      const wrapped = wrapWithNono({
        launch,
        executable,
        profile,
        releases: releasesGrant,
      });
      try {
        return execFileSync(wrapped.command, ["wrap", "-s", ...wrapped.args.slice(1)], {
          cwd,
          encoding: "utf8",
          timeout: 60000,
          env: { ...process.env, NONO_THEME: "minimal" },
        });
      } catch (error) {
        return `${error.stdout || ""}${error.stderr || ""}`;
      }
    };
    const granted = wrap(releases);
    assert.match(granted, /HOOK:HOOK-OF-2\.0\.0/);
    // The install root beside the releases stays out of reach.
    assert.match(granted, /ROOT:.*(not permitted|denied)/i);
    // The control: a session that reads only the release it started from.
    assert.doesNotMatch(wrap(null), /HOOK-OF-2\.0\.0/);
  },
);
