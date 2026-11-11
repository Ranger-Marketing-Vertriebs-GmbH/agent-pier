// test-runner-timeout-ms: 300000
// Starts real sandboxes and child processes: its own timeout class under load
// (scripts/test-runner.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  NonoSandbox,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";

/**
 * What a managed OpenCode account needs inside a sandbox, through a real nono and
 * the launch AgentPier really composes: the account store's launch (the four XDG
 * folders inside the account folder, the grant on that folder) handed to the nono
 * adapter. The CLI is a shell script that does what OpenCode does, and OpenCode
 * itself, signed out, where it is installed. Skipped without nono, like
 * nono-cli-needs.test.js.
 *
 * The home folder lies in the workspace, which no grant and no group of the profile
 * reads: nono's built-in `default` profile reads `/private` on macOS, so a home below
 * the temporary folder would hide a missing grant.
 */
function onPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean))
    try {
      const candidate = path.join(directory, name);
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  return null;
}
const executable = onPath("nono");
const reason = !executable
  ? "nono is not installed"
  : !["darwin", "linux"].includes(process.platform)
    ? `nono does not support ${process.platform}`
    : null;
const options = reason ? { skip: reason } : {};
const opencode = onPath("opencode");
const bun = onPath("bun");
const withOpenCode = reason || opencode ? options : { skip: "opencode is not installed" };
const withBun =
  reason || opencode || bun ? options : { skip: "neither opencode nor bun is installed" };

// Grants nothing of its own beyond what lets a binary start (nono-cli-needs.test.js).
const restrictive = {
  meta: { name: "agentpier-opencode-needs" },
  groups: {
    include: ["system_read_macos", "system_read_linux_core"],
    exclude: process.platform === "darwin" ? ["system_write_macos"] : [],
  },
  workdir: { access: "readwrite" },
  filesystem: { allow: [], read: [], write: [], deny: [] },
  network: { block: false },
};

/** A managed OpenCode account in a workspace outside every grant AgentPier composes. */
function managedAccount(t) {
  const scratch = path.join(INSTALLATION_ROOT, ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "nono-opencode-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  for (const directory of [home, cwd]) fs.mkdirSync(directory);
  const profile = path.join(root, "profile.json");
  fs.writeFileSync(profile, JSON.stringify(restrictive));
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home });
  const account = accounts.create({ name: "one", tool: "opencode" });
  /** The account's launch of `command`, as the account store composes it. */
  const launch = async (command, args, env = {}) => {
    const composed = await accounts.command(
      account.id,
      { opencode: command },
      false,
      "default",
      { cliVersion: "99.0.0" },
    );
    return { ...composed, args, env: { ...composed.env, ...env } };
  };
  return { root, home, cwd, profile, folder: accounts.profile(account.id), launch };
}

/** Runs a launch through the nono adapter, with the environment a session gets. */
async function run({ launch, profile, cwd, prepareCli }) {
  const sandbox = new NonoSandbox({
    detect: () => [{ id: "nono", installed: true, path: executable }],
    readProfiles: async () => [profile],
    ...(prepareCli ? { prepareCli } : {}),
  });
  const wrapped = await sandbox.prepare({ launch, profile, tool: "opencode", cwd });
  const result = spawnSync(wrapped.command, ["wrap", "-s", ...wrapped.args.slice(1)], {
    cwd,
    input: "",
    encoding: "utf8",
    timeout: 120000,
    // Exactly the launch's environment, as the terminal launcher starts it.
    env: { NONO_THEME: "minimal", ...wrapped.env },
  });
  return `STATUS:${result.status} ${result.stdout}${result.stderr}`;
}
const shell = (lines) => ["-c", lines.join("\n")];

test(
  "a sandboxed managed OpenCode account starts, and nono keeps its state outside the account",
  options,
  async (t) => {
    const { home, cwd, profile, folder, launch } = managedAccount(t);
    // nono's own state, where a launch without an account folder has it.
    const state = path.join(home, ".local/state/nono");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "ledger"), "NONO-STATE");
    const composed = await launch(
      "/bin/sh",
      shell([
        'echo "STATE:$XDG_STATE_HOME"',
        'echo "KV:$(mkdir -p "$XDG_STATE_HOME/opencode" && echo x > "$XDG_STATE_HOME/opencode/kv.json" && echo written)"',
        'echo "LOGIN:$( (echo x > "$XDG_DATA_HOME/auth.json") 2>&1 && echo written)"',
        'echo "CONFIG:$( (echo x > "$XDG_CONFIG_HOME/opencode.json") 2>&1 && echo written)"',
        'echo "NONO:$(cat "$HOME/.local/state/nono/ledger" 2>&1)"',
      ]),
    );
    assert.equal(composed.env.XDG_STATE_HOME, path.join(folder, "state"));
    const output = await run({ launch: composed, profile, cwd });
    assert.match(output, /^STATUS:0 /);
    assert.ok(output.includes(`STATE:${path.join(folder, "state")}\n`), output);
    assert.match(output, /KV:written/);
    assert.match(output, /LOGIN:written/);
    assert.match(output, /CONFIG:written/);
    // The session reaches nothing of nono's state.
    assert.match(output, /NONO:.*(not permitted|denied)/i);
    assert.doesNotMatch(output, /NONO-STATE/);
    assert.equal(fs.existsSync(path.join(folder, "state/nono")), false);
    // The control: nono started with the account's folders, as the launch names them,
    // places its state inside the granted account folder and refuses the launch.
    const refused = spawnSync(
      executable,
      ["wrap", "-s", "-p", profile, "--allow", folder, "--", "/bin/sh", "-c", "echo RAN"],
      { cwd, encoding: "utf8", timeout: 60000, env: composed.env },
    );
    assert.notEqual(refused.status, 0);
    assert.match(
      `${refused.stdout}${refused.stderr}`,
      /overlaps protected nono state root/,
    );
  },
);

test(
  "a managed OpenCode account runs under the sandbox profile the operator chose by name",
  options,
  async (t) => {
    const { home, cwd, launch } = managedAccount(t);
    // nono looks for a named profile under the configuration folder of its own
    // environment, where `nono profile list` found it for the launch dialog.
    const profiles = path.join(home, ".config/nono/profiles");
    fs.mkdirSync(profiles, { recursive: true });
    fs.writeFileSync(
      path.join(profiles, `${restrictive.meta.name}.json`),
      JSON.stringify(restrictive),
    );
    const composed = await launch("/bin/sh", shell(['echo "RAN:$XDG_CONFIG_HOME"']));
    const output = await run({ launch: composed, profile: restrictive.meta.name, cwd });
    assert.match(output, /^STATUS:0 /);
    assert.ok(output.includes(`RAN:${composed.env.XDG_CONFIG_HOME}\n`), output);
  },
);

test(
  "a sandboxed managed OpenCode account installs through an npm cache of its own",
  options,
  async (t) => {
    const { home, cwd, profile, folder, launch } = managedAccount(t);
    // What OpenCode's built-in npm does before it fetches a package.
    const composed = await launch(
      "/bin/sh",
      shell([
        'echo "CACHE:$(mkdir -p "${npm_config_cache:-$HOME/.npm}/_cacache" 2>&1 && echo made)"',
        'echo "SHARED:$(mkdir "$HOME/.npm" 2>&1 && echo made)"',
      ]),
    );
    const output = await run({ launch: composed, profile, cwd });
    assert.match(output, /CACHE:made/);
    assert.equal(fs.existsSync(path.join(folder, "cache/npm/_cacache")), true);
    // The user's own npm cache stays out of reach.
    assert.match(output, /SHARED:.*(not permitted|denied)/i);
    assert.equal(fs.existsSync(path.join(home, ".npm")), false);
    // The control: without what the driver adds, npm's cache is the denied `~/.npm`.
    const plain = await run({
      launch: composed,
      profile,
      cwd,
      prepareCli: (tool, value) => value,
    });
    assert.match(plain, /CACHE:.*(not permitted|denied)/i);
  },
);

test(
  "a sandboxed OpenCode can read the CA file the operator names",
  options,
  async (t) => {
    const { root, cwd, profile, launch } = managedAccount(t);
    const bundle = path.join(root, "corp-ca.pem");
    fs.writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\nCORP\n");
    const composed = await launch(
      "/bin/sh",
      shell(['echo "CA:$(grep -c CORP "$NODE_EXTRA_CA_CERTS" 2>&1)"']),
      { NODE_EXTRA_CA_CERTS: bundle },
    );
    assert.match(await run({ launch: composed, profile, cwd }), /CA:1/);
    // The control: the file lies outside everything else the sandbox may read.
    const plain = await run({
      launch: composed,
      profile,
      cwd,
      prepareCli: (tool, value) => value,
    });
    assert.match(plain, /CA:.*(not permitted|denied)/i);
  },
);

// The modules a launch names to OpenCode as plugins
// (tests/unit/opencode-plugin-imports.test.js keeps the list complete).
const plugins = [
  "server/features/sessions/native-session-opencode.js",
  "server/features/requests/opencode-plugin.js",
  "server/features/agentbus/agentbus-opencode.js",
  "server/features/memory/memory-opencode.js",
  "server/features/ssh/ssh-opencode.js",
];

test(
  "OpenCode's runtime loads AgentPier's plugins in a sandbox that cannot list the installation root",
  withBun,
  async (t) => {
    const { cwd, profile, launch } = managedAccount(t);
    const script = path.join(cwd, "plugins.mjs");
    fs.writeFileSync(
      script,
      `for (const file of ${JSON.stringify(plugins)})
  try {
    await import(${JSON.stringify(`file://${INSTALLATION_ROOT}/`)} + file);
    console.log("LOADED:" + file);
  } catch (error) {
    console.log("FAILED:" + file + " " + String(error?.message).slice(0, 300));
  }
`,
    );
    // OpenCode is a compiled Bun program and runs a script as Bun with this variable.
    const composed = await launch(
      opencode || bun,
      ["run", script],
      opencode ? { BUN_BE_BUN: "1" } : {},
    );
    const output = await run({ launch: composed, profile, cwd });
    assert.doesNotMatch(output, /FAILED:/);
    for (const file of plugins) assert.ok(output.includes(`LOADED:${file}\n`), output);
  },
);

test(
  "a signed-out OpenCode starts in a sandbox with a managed account's folders",
  withOpenCode,
  async (t) => {
    const { home, cwd, profile, folder, launch } = managedAccount(t);
    const paths = await run({
      launch: await launch(opencode, ["debug", "paths"]),
      profile,
      cwd,
    });
    assert.match(paths, /^STATUS:0 /);
    for (const [name, directory] of [
      ["data", "data/opencode"],
      ["config", "config/opencode"],
      ["state", "state/opencode"],
      ["cache", "cache/opencode"],
    ])
      assert.match(
        paths,
        new RegExp(`^${name}\\s+${path.join(folder, directory)}$`, "m"),
        paths,
      );
    // Its login is a file in the account's data folder, not the keychain.
    const login = await run({
      launch: await launch(opencode, ["auth", "list"]),
      profile,
      cwd,
    });
    assert.match(login, /^STATUS:0 /);
    assert.ok(login.includes(path.join(folder, "data/opencode/auth.json")), login);
    assert.match(login, /0 credentials/);
    // Nothing of it lands in the home folder, which the sandbox does not grant.
    assert.equal(fs.existsSync(path.join(home, ".local/share/opencode")), false);
    assert.equal(fs.existsSync(path.join(folder, "state/nono")), false);
  },
);
