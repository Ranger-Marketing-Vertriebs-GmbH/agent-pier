// test-runner-timeout-ms: 300000
// Starts real sandboxes and child processes: its own timeout class under load
// (scripts/test-runner.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  wrapWithNono,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { cliDriver } from "../../server/features/clis/drivers.js";
import { installShim } from "../../server/features/accounts/managed-logins.js";
import { executablePackageGrants } from "../../server/features/clis/codex/sandbox.js";

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
    // On Linux the profile leaves /tmp writable, so the folder lies in the home
    // folder there: the control below needs a place nothing else grants.
    const temporary = fs.realpathSync(
      fs.mkdtempSync(
        process.platform === "linux" ? path.join(os.homedir(), ".apcn-") : "/tmp/apcn-",
      ),
    );
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

test("a sandboxed Codex can read the CA file the operator names", options, (t) => {
  const { root, profile, cwd } = workspace(t);
  const bundle = path.join(root, "corp-ca.pem");
  fs.writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\nCORP\n");
  const launch = {
    command: "/bin/sh",
    args: ["-c", 'echo "CA:$(grep -c CORP "$CODEX_CA_CERTIFICATE" 2>&1)"'],
    env: { PATH: "/usr/bin:/bin", CODEX_CA_CERTIFICATE: bundle },
  };
  const prepared = cliDriver("codex").sandboxLaunch(launch);
  assert.equal(prepared.env.SSL_CERT_FILE, undefined);
  assert.match(run({ launch: prepared, profile, cwd }), /CA:1/);
  // The control: the file lies outside everything else the sandbox may read.
  assert.match(run({ launch, profile, cwd }), /CA:.*(not permitted|denied)/i);
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
    const sockets = fs.realpathSync(fs.mkdtempSync("/tmp/apcn-"));
    t.after(() => fs.rmSync(sockets, { recursive: true, force: true }));
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
      // A short folder for the socket: a long one would add the per-user fallback
      // in /tmp to the launch (socketDirectories).
      env: { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: sockets },
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

/**
 * A managed account of Codex or OpenCode beside the CLI's own profile, linked the
 * way linkAssets links them. The home folder lies in the workspace, which no grant
 * and no group of the profile reads: a home under the system's temporary folder
 * would be readable through nono's `default` profile and hide a missing grant.
 */
const linkedLayouts = {
  codex: {
    native: ".codex",
    config: "codex",
    folders: ["agents", "commands", "plugins", "skills", ".tmp/marketplaces"],
    env: (home, account) => ({ HOME: home, CODEX_HOME: path.join(account, "codex") }),
  },
  opencode: {
    native: ".config/opencode",
    config: "config/opencode",
    folders: ["agents", "commands", "plugins", "skills", "plugin"],
    env: (home, account) => ({
      HOME: home,
      XDG_CONFIG_HOME: path.join(account, "config"),
    }),
  },
};
function linkedAccount(root, tool) {
  const layout = linkedLayouts[tool];
  const home = path.join(root, "home");
  const shared = path.join(home, layout.native);
  const account = path.join(root, "profiles/one");
  const config = path.join(account, layout.config);
  for (const name of layout.folders) {
    fs.mkdirSync(path.join(shared, name), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(config, name)), { recursive: true });
    fs.symlinkSync(path.join(shared, name), path.join(config, name), "dir");
  }
  fs.writeFileSync(path.join(shared, "skills/skill.md"), "SKILL");
  fs.writeFileSync(path.join(shared, "auth.json"), "LOGIN");
  fs.writeFileSync(path.join(shared, "history.jsonl"), "HISTORY");
  return { home, shared, account, config, env: layout.env(home, account) };
}

for (const tool of ["codex", "opencode"])
  test(
    `a sandboxed managed ${tool} account reaches the linked folders and no more of the profile`,
    options,
    (t) => {
      const { root, profile, cwd } = workspace(t);
      const { shared, account, config, env } = linkedAccount(root, tool);
      const script = [
        `echo "AGENTS:$(ls "${config}/agents/" 2>&1 && echo listed)"`,
        `echo "SKILL:$(cat "${config}/skills/skill.md" 2>&1)"`,
        `echo "LAST:$(ls "${config}/${linkedLayouts[tool].folders.at(-1)}/" 2>&1 && echo listed)"`,
        `echo "PLANT:$( (echo x > "${config}/skills/planted") 2>&1 && echo written)"`,
        `echo "LOGIN:$(cat "${shared}/auth.json" 2>&1)"`,
        `echo "HISTORY:$(cat "${shared}/history.jsonl" 2>&1)"`,
        `echo "PROFILE:$(ls "${shared}/" 2>&1 && echo listed)"`,
      ].join("\n");
      const launch = {
        command: "/bin/sh",
        args: ["-c", script],
        env: { ...env, PATH: "/usr/bin:/bin" },
        // The account's own folder, as the account store grants it.
        sandboxGrants: [{ access: "allow", path: account }],
      };
      const granted = run({
        launch: cliDriver(tool).sandboxLaunch(launch),
        profile,
        cwd,
      });
      assert.match(granted, /AGENTS:listed/);
      assert.match(granted, /SKILL:SKILL/);
      assert.match(granted, /LAST:listed/);
      assert.match(granted, /PLANT:.*(not permitted|denied)/i);
      // The login and the history of the CLI's own profile stay out of reach.
      assert.match(granted, /LOGIN:.*(not permitted|denied)/i);
      assert.match(granted, /HISTORY:.*(not permitted|denied)/i);
      assert.match(granted, /PROFILE:.*(not permitted|denied)/i);
      assert.doesNotMatch(granted, /LOGIN:LOGIN|HISTORY:HISTORY/);
      assert.equal(fs.existsSync(path.join(shared, "skills/planted")), false);
      // The control: the account folder alone does not reach the link targets.
      const plain = run({ launch, profile, cwd });
      assert.match(plain, /AGENTS:.*(not permitted|denied)/i);
      assert.match(plain, /SKILL:.*(not permitted|denied)/i);
    },
  );

// Codex itself, signed out: its app server ends at start when it may not read the
// folder its `agents` link points at ("Operation not permitted (os error 1)").
const codexExecutable = (() => {
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean))
    try {
      const candidate = path.join(directory, "codex");
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  return null;
})();

test(
  "Codex's app server starts in a sandbox with a managed account's linked folders",
  reason || codexExecutable ? options : { skip: "codex is not installed" },
  (t) => {
    const { root, profile, cwd } = workspace(t);
    const { account, env } = linkedAccount(root, "codex");
    const launch = {
      command: codexExecutable,
      args: ["app-server", "--stdio"],
      env,
      sandboxGrants: [{ access: "allow", path: account }],
    };
    const start = (prepared) => {
      const wrapped = wrapWithNono({ launch: prepared, executable, profile });
      // The input ends at once: a server that started leaves without an error.
      const result = spawnSync(
        wrapped.command,
        ["wrap", "-s", ...wrapped.args.slice(1)],
        {
          cwd,
          input: "",
          encoding: "utf8",
          timeout: 60000,
          env: { ...process.env, NONO_THEME: "minimal", ...wrapped.env },
        },
      );
      return `STATUS:${result.status} ${result.stdout}${result.stderr}`;
    };
    const granted = start(cliDriver("codex").sandboxLaunch(launch));
    assert.match(granted, /^STATUS:0 /);
    assert.doesNotMatch(granted, /not permitted/i);
    // The control: without the grants the server ends before it serves anything.
    assert.match(start(launch), /^STATUS:1 [^]*Operation not permitted/);
  },
);

test(
  "a sandboxed standalone Codex reads its package folder and no more of the profile",
  options,
  (t) => {
    const { root, profile, cwd } = workspace(t);
    // Codex's standalone install: `~/.local/bin/codex` links into `~/.codex/packages`.
    const home = path.join(root, "home");
    const packages = path.join(home, ".codex/packages/standalone");
    const release = path.join(packages, "releases/1.0.0");
    fs.mkdirSync(path.join(release, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(release, "codex-package.json"),
      JSON.stringify({ entrypoint: "bin/codex", marker: "PACKAGE-FILE" }),
    );
    fs.writeFileSync(path.join(release, "bin/codex-code-mode-host"), "HOST");
    fs.writeFileSync(path.join(home, ".codex/auth.json"), "LOGIN");
    // Stands in for Codex: reads what Codex reads beside its executable.
    fs.writeFileSync(
      path.join(release, "bin/codex"),
      [
        "#!/bin/sh",
        `echo "PACKAGE:$(cat '${release}/codex-package.json' 2>&1)"`,
        `echo "HOST:$(cat '${home}/.local/bin/codex-code-mode-host' 2>&1)"`,
        `echo "LOGIN:$(cat '${home}/.codex/auth.json' 2>&1)"`,
        `echo "PROFILE:$(ls '${home}/.codex/' 2>&1 && echo listed)"`,
        `echo "PLANT:$( (echo x > '${release}/planted') 2>&1 && echo written)"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.symlinkSync(release, path.join(packages, "current"), "dir");
    fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    for (const name of ["codex", "codex-code-mode-host"])
      fs.symlinkSync(
        path.join(packages, "current/bin", name),
        path.join(home, ".local/bin", name),
      );
    const launch = {
      command: path.join(home, ".local/bin/codex"),
      args: [],
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    };
    const granted = run({
      launch: cliDriver("codex").sandboxLaunch(launch),
      profile,
      cwd,
    });
    assert.match(granted, /PACKAGE:.*PACKAGE-FILE/);
    assert.match(granted, /HOST:HOST/);
    assert.match(granted, /LOGIN:.*(not permitted|denied)/i);
    assert.match(granted, /PROFILE:.*(not permitted|denied)/i);
    assert.match(granted, /PLANT:.*(not permitted|denied)/i);
    assert.equal(fs.existsSync(path.join(release, "planted")), false);
    // The control: the executable's own grant reaches nothing beside it.
    const plain = run({ launch, profile, cwd });
    assert.match(plain, /PACKAGE:.*(not permitted|denied)/i);
    assert.match(plain, /HOST:.*(not permitted|denied)/i);
  },
);

// The installed Codex, when it is a standalone install (a package folder of its own).
const [installedPackage] = codexExecutable
  ? executablePackageGrants(codexExecutable, process.env)
  : [];

test(
  "the installed standalone Codex's package folder is readable in a sandbox",
  reason || installedPackage ? options : { skip: "codex is not a standalone install" },
  (t) => {
    const { profile, cwd } = workspace(t);
    const file = path.join(installedPackage.path, "codex-package.json");
    const launch = {
      command: "/bin/sh",
      args: ["-c", `echo "PACKAGE:$(cat '${file}' 2>&1)"`],
      env: { PATH: "/usr/bin:/bin" },
    };
    assert.match(
      run({ launch: { ...launch, sandboxGrants: [installedPackage] }, profile, cwd }),
      /PACKAGE:[^]*entrypoint/,
    );
    // The control: nothing else of the profile makes the package readable.
    assert.match(run({ launch, profile, cwd }), /PACKAGE:.*(not permitted|denied)/i);
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
