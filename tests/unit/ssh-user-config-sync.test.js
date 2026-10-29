// SshUserConfig: when an instance writes ~/.ssh/config, the real `ssh -G` check after
// every write, rollback and retry. Every home is a stand-in under the OS temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SSH_CONFIG_CHECK_FAILED,
  SshUserConfig,
  sshUserConfigEnabled,
} from "../../server/features/ssh/ssh-user-config-sync.js";

const skip = spawnSync("ssh", ["-V"]).status !== 0 && "no ssh client";
const unprivileged = process.getuid?.() === 0 && "root reads all";

function setup(t, { folder = "data" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ssh-user-sync-")));
  t.after(() => {
    for (const dir of [root, ...walk(root)]) fs.chmodSync(dir, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  assert.notEqual(home, os.homedir());
  const dataDir = path.join(root, folder);
  const agents = path.join(dataDir, "ssh-agents");
  fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
  const logs = [];
  const log = {
    warn: (...args) => logs.push(["warn", ...args]),
    error: (...args) => logs.push(["error", ...args]),
  };
  const session = (id, address) => {
    const folder = path.join(agents, id);
    fs.mkdirSync(folder, { mode: 0o700 });
    const configPath = path.join(folder, "ssh_config");
    fs.writeFileSync(configPath, `Host proxmox-2\n  HostName ${address}\n`, {
      mode: 0o600,
    });
    return { configPath, aliases: ["proxmox-2"] };
  };
  const user = new SshUserConfig({ home, dataDir, log });
  return {
    root,
    home,
    dataDir,
    agents,
    logs,
    session,
    user,
    config: path.join(home, ".ssh", "config"),
    dispatcher: path.join(agents, "include.conf"),
  };
}

function walk(folder) {
  const found = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true }))
    if (entry.isDirectory()) {
      const child = path.join(folder, entry.name);
      fs.chmodSync(child, 0o700);
      found.push(child, ...walk(child));
    }
  return found;
}

const quietSsh = (config) => {
  const env = { ...process.env };
  delete env.AGENTPIER_SSH_CONFIG;
  return spawnSync("ssh", ["-F", config, "-G", "somehost"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

test("only persistent instances outside dev and the opt-out write ~/.ssh/config", () => {
  const tmp = os.tmpdir();
  const home = "/Users/someone/Library/Application Support/AgentPier";
  assert.equal(sshUserConfigEnabled({ dataDir: home, env: {}, tmp }), true);
  assert.equal(
    sshUserConfigEnabled({ dataDir: home, env: { AGENTPIER_DEV: "1" }, tmp }),
    false,
  );
  assert.equal(
    sshUserConfigEnabled({ dataDir: home, env: { AGENTPIER_SSH_USER_CONFIG: "0" }, tmp }),
    false,
  );
  assert.equal(
    sshUserConfigEnabled({ dataDir: path.join(tmp, "x", "data"), env: {}, tmp }),
    false,
  );
  assert.equal(sshUserConfigEnabled({ dataDir: "/tmp/spike-data", env: {}, tmp }), false);
});

test(
  "the first entry installs the checked block and the dispatcher follows",
  { skip },
  async (t) => {
    const f = setup(t);
    await f.user.update([]);
    assert.equal(fs.existsSync(f.dispatcher), false);
    assert.equal(fs.existsSync(f.config), false);
    const one = f.session("s1", "10.0.0.1");
    await f.user.update([one]);
    assert.match(fs.readFileSync(f.config, "utf8"), /^# BEGIN AgentPier [0-9a-f]{8} /);
    assert.match(fs.readFileSync(f.dispatcher, "utf8"), /originalhost proxmox-2/);
    assert.equal(fs.statSync(f.dispatcher).mode & 0o777, 0o600);
    assert.equal(f.user.problemFor(one.configPath), null);
    assert.equal(
      fs.readdirSync(path.dirname(f.config)).some((name) => name.includes("check")),
      false,
    );
    await f.user.update([]);
    assert.doesNotMatch(fs.readFileSync(f.dispatcher, "utf8"), /originalhost/);
    assert.equal(quietSsh(f.config).status, 0);
  },
);

test(
  "an unreadable include.conf rolls the block back and is tried again",
  {
    skip: skip || unprivileged,
  },
  async (t) => {
    const f = setup(t);
    const one = f.session("s1", "10.0.0.1");
    fs.mkdirSync(path.dirname(f.config), { mode: 0o700 });
    fs.writeFileSync(f.config, "Host mine\n", { mode: 0o600 });
    await f.user.update([one]);
    assert.match(fs.readFileSync(f.config, "utf8"), /BEGIN AgentPier/);
    // A dispatcher ssh cannot read (left by `sudo`, a restore or an ACL) that AgentPier
    // cannot replace either: the write fails as it would on a root-owned file.
    fs.chmodSync(f.dispatcher, 0o000);
    const write = f.user.writeDispatcher;
    f.user.writeDispatcher = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    assert.equal(quietSsh(f.config).status, 255);
    await f.user.update([one]);
    assert.equal(fs.readFileSync(f.config, "utf8"), "Host mine\n");
    assert.equal(quietSsh(f.config).status, 0);
    assert.equal(f.user.problemFor(one.configPath), SSH_CONFIG_CHECK_FAILED);
    assert.ok(
      f.logs.some(
        ([, message, code]) =>
          message.includes("left unchanged") && code === SSH_CONFIG_CHECK_FAILED,
      ),
    );
    // Fixed: the next sync installs it again.
    f.user.writeDispatcher = write;
    await f.user.update([one]);
    assert.match(fs.readFileSync(f.config, "utf8"), /BEGIN AgentPier/);
    assert.equal(f.user.problemFor(one.configPath), null);
  },
);

test(
  "a session config ssh cannot read leaves only that session out",
  {
    skip: skip || unprivileged,
  },
  async (t) => {
    const f = setup(t);
    const one = f.session("s1", "10.0.0.1");
    const two = f.session("s2", "10.0.0.2");
    fs.chmodSync(two.configPath, 0o000);
    await f.user.update([one, two]);
    const dispatcher = fs.readFileSync(f.dispatcher, "utf8");
    assert.ok(dispatcher.includes(one.configPath));
    assert.ok(!dispatcher.includes(two.configPath));
    assert.match(fs.readFileSync(f.config, "utf8"), /BEGIN AgentPier/);
    assert.equal(f.user.problemFor(one.configPath), null);
    assert.equal(f.user.problemFor(two.configPath), SSH_CONFIG_CHECK_FAILED);
    assert.equal(quietSsh(f.config).status, 0);
    fs.chmodSync(two.configPath, 0o600);
    await f.user.update([one, two]);
    assert.ok(fs.readFileSync(f.dispatcher, "utf8").includes(two.configPath));
    assert.equal(f.user.problemFor(two.configPath), null);
  },
);

test(
  "a refused install is reported and tried again on the next update",
  { skip },
  async (t) => {
    const f = setup(t);
    const one = f.session("s1", "10.0.0.1");
    fs.mkdirSync(path.dirname(f.config), { mode: 0o700 });
    fs.symlinkSync(path.join(f.root, "dotfiles-config"), f.config);
    await f.user.update([one]);
    assert.equal(f.user.problemFor(one.configPath), "SSH_CONFIG_LINK");
    assert.equal(fs.existsSync(path.join(f.root, "dotfiles-config")), false);
    fs.rmSync(f.config);
    await f.user.update([one]);
    assert.equal(f.user.problemFor(one.configPath), null);
    assert.match(fs.readFileSync(f.config, "utf8"), /BEGIN AgentPier/);
    assert.equal(f.logs.filter(([level]) => level === "warn").length, 1);
  },
);

test("a data folder the block cannot name is reported, ~/.ssh stays untouched", async (t) => {
  const f = setup(t, { folder: "data$x" });
  const one = f.session("s1", "10.0.0.1");
  await f.user.update([one]);
  assert.equal(f.user.problemFor(one.configPath), "SSH_CONFIG_PATH_UNSUPPORTED");
  assert.equal(fs.existsSync(f.config), false);
});
