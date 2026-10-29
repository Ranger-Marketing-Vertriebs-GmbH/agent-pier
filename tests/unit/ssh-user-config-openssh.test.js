// The ~/.ssh/config block read by the real OpenSSH client (`ssh -G`, no connection),
// through `-F` on a stand-in home's config; the real ~/.ssh is never read or written.
// OpenSSH runs `Match exec` through $SHELL, so every installed shell is tried.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  installSshConfigInclude,
  renderDispatcher,
} from "../../server/features/ssh/ssh-user-config.js";

const sshAvailable = spawnSync("ssh", ["-V"]).status === 0;
const own = "Port 2222\nCompression yes\nHost *.corp\n  User corpuser\n";
const key = "abcd1234";
const shells = ["sh", "bash", "zsh", "dash", "tcsh", "csh", "fish"]
  .map((name) => {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    });
    return found.status === 0 ? found.stdout.trim() : null;
  })
  .filter((shell) => shell && path.isAbsolute(shell));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ssh-include-")));
  t.after(() => {
    for (const folder of walk(root)) fs.chmodSync(folder, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Spaces and glob characters in the data folder must stay literal.
  const data = path.join(root, "data [x]*?");
  const agents = path.join(data, "ssh-agents");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const sessions = {};
  for (const [id, address, user] of [
    ["s1", "10.0.0.1", "one"],
    ["s2", "10.0.0.2", "two"],
  ]) {
    const folder = path.join(agents, id);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const configPath = path.join(folder, "ssh_config");
    const text = `Host proxmox-2\n  HostName ${address}\n  User ${user}\n`;
    fs.writeFileSync(configPath, text, { mode: 0o600 });
    sessions[id] = { folder, configPath };
  }
  const dispatcher = path.join(agents, "include.conf");
  const entries = Object.values(sessions).map(({ configPath }) => ({
    configPath,
    aliases: ["proxmox-2"],
  }));
  fs.writeFileSync(dispatcher, renderDispatcher(entries), { mode: 0o600 });
  const base = path.join(root, "base_config");
  fs.writeFileSync(base, own, { mode: 0o600 });
  const config = path.join(home, ".ssh", "config");
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  fs.writeFileSync(config, own, { mode: 0o600 });
  installSshConfigInclude({ home, dispatcher, key });
  return { data, agents, sessions, base, config };
}

function* walk(folder) {
  yield folder;
  fs.chmodSync(folder, 0o700);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true }))
    if (entry.isDirectory()) yield* walk(path.join(folder, entry.name));
}

function resolve(config, host, sessionConfig, shell = "/bin/sh") {
  const env = { ...process.env, SHELL: shell };
  delete env.AGENTPIER_SSH_CONFIG;
  if (sessionConfig) env.AGENTPIER_SSH_CONFIG = sessionConfig;
  const result = spawnSync("ssh", ["-F", config, "-G", host], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const values = Object.fromEntries(
    result.stdout
      .split("\n")
      .map((line) => line.split(" "))
      .map(([name, ...rest]) => [name, rest.join(" ")]),
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, values };
}

const skip = !sshAvailable && "no ssh client";

test(
  "without AGENTPIER_SSH_CONFIG every shell resolves exactly as without the block",
  {
    skip,
  },
  (t) => {
    const { base, config } = fixture(t);
    assert.ok(shells.includes("/bin/sh"));
    for (const shell of shells)
      for (const host of ["somehost", "a.corp", "proxmox-2"]) {
        const plain = resolve(base, host, null, shell);
        const managed = resolve(config, host, null, shell);
        assert.equal(managed.status, plain.status, `${shell} ${host}`);
        assert.equal(managed.stdout, plain.stdout, `${shell} ${host}`);
        assert.equal(managed.stderr, plain.stderr, `${shell} ${host}: ${managed.stderr}`);
      }
  },
);

test(
  "inside a session an alias resolves to that session's own host in every shell",
  {
    skip,
  },
  (t) => {
    const { sessions, base, config } = fixture(t);
    for (const shell of shells) {
      const quiet = resolve(base, "proxmox-2", null, shell).stderr;
      const one = resolve(config, "proxmox-2", sessions.s1.configPath, shell);
      assert.equal(one.status, 0, one.stderr);
      assert.equal(one.stderr, quiet, shell);
      assert.equal(one.values.hostname, "10.0.0.1", shell);
      assert.equal(one.values.user, "one", shell);
      // `Match all` gives the user's own lines after the block back to every host.
      assert.equal(one.values.port, "2222");
      assert.equal(one.values.compression, "yes");
      const two = resolve(config, "proxmox-2", sessions.s2.configPath, shell);
      assert.equal(two.values.hostname, "10.0.0.2", shell);
      assert.equal(two.values.user, "two", shell);
    }
    assert.equal(
      resolve(config, "a.corp", sessions.s1.configPath).values.user,
      "corpuser",
    );
  },
);

test("without Match all the user's following lines would be swallowed", { skip }, (t) => {
  const { config } = fixture(t);
  const text = fs.readFileSync(config, "utf8");
  const broken = path.join(path.dirname(config), "broken_config");
  const end = `# END AgentPier ${key}`;
  fs.writeFileSync(broken, text.replace(`Match all\n${end}`, end), { mode: 0o600 });
  // In the user's own terminal the Match is false and would hold the rest.
  assert.equal(resolve(config, "somehost").values.port, "2222");
  assert.equal(resolve(broken, "somehost").values.port, "22");
});

test(
  "folders a sandbox cannot read are skipped without an error",
  {
    skip: skip || (process.getuid?.() === 0 && "root reads all"),
  },
  (t) => {
    const { agents, sessions, base, config } = fixture(t);
    const quiet = resolve(base, "proxmox-2").stderr;
    // Another session's folder: its Include matches nothing.
    fs.chmodSync(sessions.s2.folder, 0o000);
    const one = resolve(config, "proxmox-2", sessions.s1.configPath);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.values.hostname, "10.0.0.1");
    assert.equal(one.stderr, quiet);
    fs.chmodSync(sessions.s2.folder, 0o700);
    // The whole agents folder: ssh falls back to the user's config alone.
    fs.chmodSync(agents, 0o000);
    const none = resolve(config, "proxmox-2", sessions.s1.configPath);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.values.hostname, "proxmox-2");
    assert.equal(none.values.port, "2222");
    assert.equal(none.stderr, quiet);
  },
);

test("a block whose data folder was deleted stays harmless", { skip }, (t) => {
  const { data, sessions, base, config } = fixture(t);
  fs.rmSync(data, { recursive: true, force: true });
  for (const shell of shells) {
    for (const sessionConfig of [null, sessions.s1.configPath]) {
      const plain = resolve(base, "proxmox-2", sessionConfig, shell);
      const stale = resolve(config, "proxmox-2", sessionConfig, shell);
      assert.equal(stale.status, plain.status, shell);
      assert.equal(stale.stdout, plain.stdout, shell);
      assert.equal(stale.stderr, plain.stderr, shell);
    }
  }
});
