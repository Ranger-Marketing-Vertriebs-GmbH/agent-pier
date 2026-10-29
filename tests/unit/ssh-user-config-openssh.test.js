// The ~/.ssh/config block read by the real OpenSSH client (`ssh -G`, no connection),
// through `-F` on a stand-in home's config; the real ~/.ssh is never read or written.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SSH_CONFIG_END,
  installSshConfigInclude,
  renderDispatcher,
} from "../../server/features/ssh/ssh-user-config.js";

const sshAvailable = spawnSync("ssh", ["-V"]).status === 0;
const own = "Port 2222\nCompression yes\nHost *.corp\n  User corpuser\n";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ssh-include-")));
  t.after(() => {
    for (const folder of walk(root)) fs.chmodSync(folder, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Spaces and glob characters in the data folder must stay literal.
  const agents = path.join(root, "data [x]*?", "ssh-agents");
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
    fs.writeFileSync(
      configPath,
      `Host proxmox-2\n  HostName ${address}\n  User ${user}\n`,
      {
        mode: 0o600,
      },
    );
    sessions[id] = { folder, configPath };
  }
  const dispatcher = path.join(agents, "include.conf");
  fs.writeFileSync(
    dispatcher,
    renderDispatcher(
      Object.values(sessions).map(({ configPath }) => ({
        configPath,
        aliases: ["proxmox-2"],
      })),
    ),
    { mode: 0o600 },
  );
  const base = path.join(root, "base_config");
  fs.writeFileSync(base, own, { mode: 0o600 });
  const config = path.join(home, ".ssh", "config");
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  fs.writeFileSync(config, own, { mode: 0o600 });
  installSshConfigInclude({ home, dispatcher });
  return { agents, sessions, base, config };
}

function* walk(folder) {
  yield folder;
  fs.chmodSync(folder, 0o700);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true }))
    if (entry.isDirectory()) yield* walk(path.join(folder, entry.name));
}

function resolve(config, host, sessionConfig) {
  const env = { ...process.env, SHELL: "/bin/sh" };
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
      .map(([key, ...rest]) => [key, rest.join(" ")]),
  );
  // ssh -G notes that stdin is no terminal; anything else would be the config's.
  const stderr = result.stderr.replace(
    /^Pseudo-terminal will not be allocated.*\r?\n/m,
    "",
  );
  return { status: result.status, stdout: result.stdout, stderr, values };
}

test(
  "without AGENTPIER_SSH_CONFIG ssh resolves exactly as without the block",
  {
    skip: !sshAvailable && "no ssh client",
  },
  (t) => {
    const { base, config } = fixture(t);
    for (const host of ["somehost", "a.corp", "proxmox-2"]) {
      const plain = resolve(base, host);
      const managed = resolve(config, host);
      assert.equal(managed.status, 0, managed.stderr);
      assert.equal(managed.stdout, plain.stdout, host);
      assert.equal(managed.stderr, plain.stderr, host);
    }
  },
);

test(
  "inside a session an alias resolves to that session's own host",
  {
    skip: !sshAvailable && "no ssh client",
  },
  (t) => {
    const { sessions, config } = fixture(t);
    const one = resolve(config, "proxmox-2", sessions.s1.configPath);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.values.hostname, "10.0.0.1");
    assert.equal(one.values.user, "one");
    // `Match all` gives the user's own lines after the block back to every host.
    assert.equal(one.values.port, "2222");
    assert.equal(one.values.compression, "yes");
    const two = resolve(config, "proxmox-2", sessions.s2.configPath);
    assert.equal(two.values.hostname, "10.0.0.2");
    assert.equal(two.values.user, "two");
    assert.equal(
      resolve(config, "a.corp", sessions.s1.configPath).values.user,
      "corpuser",
    );
  },
);

test(
  "without Match all the user's following lines would be swallowed",
  {
    skip: !sshAvailable && "no ssh client",
  },
  (t) => {
    const { config } = fixture(t);
    const text = fs.readFileSync(config, "utf8");
    const broken = path.join(path.dirname(config), "broken_config");
    fs.writeFileSync(
      broken,
      text.replace(`Match all\n${SSH_CONFIG_END}`, SSH_CONFIG_END),
      {
        mode: 0o600,
      },
    );
    // In the user's own terminal the Match is false and would hold the rest.
    assert.equal(resolve(config, "somehost").values.port, "2222");
    assert.equal(resolve(broken, "somehost").values.port, "22");
  },
);

test(
  "folders a sandbox cannot read are skipped without an error",
  {
    skip:
      (!sshAvailable && "no ssh client") ||
      (process.getuid?.() === 0 && "root reads all"),
  },
  (t) => {
    const { agents, sessions, config } = fixture(t);
    // Another session's folder: its Include matches nothing.
    fs.chmodSync(sessions.s2.folder, 0o000);
    const one = resolve(config, "proxmox-2", sessions.s1.configPath);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.values.hostname, "10.0.0.1");
    assert.equal(one.stderr, "");
    fs.chmodSync(sessions.s2.folder, 0o700);
    // The whole agents folder: ssh falls back to the user's config alone.
    fs.chmodSync(agents, 0o000);
    const none = resolve(config, "proxmox-2", sessions.s1.configPath);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.values.hostname, "proxmox-2");
    assert.equal(none.values.port, "2222");
    assert.equal(none.stderr, "");
  },
);
