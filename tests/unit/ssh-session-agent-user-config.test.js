// SessionSshAgents keeps the ~/.ssh/config block and its dispatcher (ssh-user-config.js)
// in step with its agents. Every home here is a stand-in under the OS temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionSshAgents } from "../../server/features/ssh/ssh-session-agents.js";
import { SshUserConfig } from "../../server/features/ssh/ssh-user-config-sync.js";
import { fixture, launch } from "../helpers/ssh-session-agents-fixture.js";

function userHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ssh-user-home-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.notEqual(home, os.homedir());
  return home;
}

function withUserConfig(t, home) {
  const f = fixture(t);
  f.agents.userConfig = new SshUserConfig({ home, dataDir: f.dataDir, log: f.log });
  return f;
}

const dispatcherOf = (f) =>
  fs.readFileSync(path.join(f.dataDir, "ssh-agents", "include.conf"), "utf8");

test("the first agent puts the block in place and the dispatcher follows its aliases", async (t) => {
  const home = userHome(t);
  const f = withUserConfig(t, home);
  const id = randomUUID();
  await f.grants.set({ id }, ["access-a"]);
  const { record } = await launch(f, { id });
  await f.agents.userConfig.idle();
  const config = fs.readFileSync(path.join(home, ".ssh", "config"), "utf8");
  assert.match(config, /^# BEGIN AgentPier [0-9a-f]{8} \(managed, do not edit\)\n/);
  assert.match(config, /include\.con\[f\]"\nMatch all\n# END AgentPier [0-9a-f]{8}\n$/);
  assert.match(
    dispatcherOf(f),
    new RegExp(`originalhost proxmox-2 exec .*${id}/ssh_config`),
  );
  assert.equal(f.agents.status(record).sshConfig, undefined);
  // The check runs the OpenSSH this agent resolved.
  assert.equal(f.agents.userConfig.ssh, record.sshAgent.binaries.ssh);
  await f.grants.set(record, []);
  await f.agents.sync(record);
  await f.agents.userConfig.idle();
  assert.doesNotMatch(dispatcherOf(f), /originalhost/);
  await f.grants.set(record, ["access-a"]);
  await f.agents.sync(record);
  await f.agents.userConfig.idle();
  assert.match(dispatcherOf(f), /originalhost proxmox-2/);
  await f.agents.discard(id);
  await f.agents.userConfig.idle();
  assert.doesNotMatch(dispatcherOf(f), /originalhost/);
});

test("a refused ~/.ssh/config is reported in the agent status and logged", async (t) => {
  const home = userHome(t);
  fs.mkdirSync(path.join(home, ".ssh"), { mode: 0o700 });
  fs.symlinkSync(path.join(home, "dotfiles-config"), path.join(home, ".ssh", "config"));
  const f = withUserConfig(t, home);
  const id = randomUUID();
  await f.grants.set({ id }, ["access-a"]);
  const { record } = await launch(f, { id });
  await f.agents.userConfig.idle();
  const status = f.agents.status(record);
  assert.equal(status.state, "ready");
  assert.equal(status.sshConfig, "SSH_CONFIG_LINK");
  assert.ok(
    f.logs.some(([level, , code]) => level === "warn" && code === "SSH_CONFIG_LINK"),
  );
  assert.equal(fs.existsSync(path.join(home, "dotfiles-config")), false);
});

test("a service start with a running agent session puts the block in place", async (t) => {
  const home = userHome(t);
  const f = fixture(t);
  const id = randomUUID();
  await f.grants.set({ id }, ["access-a"]);
  const { record } = await launch(f, { id });
  await f.agents.close();
  assert.equal(fs.existsSync(path.join(home, ".ssh")), false);
  const restarted = new SessionSshAgents({
    ...f.deps,
    userConfig: new SshUserConfig({ home, dataDir: f.dataDir, log: f.log }),
  });
  f.started.push(restarted);
  await restarted.restore();
  await restarted.userConfig.idle();
  assert.equal(restarted.status(record).state, "ready");
  assert.match(
    fs.readFileSync(path.join(home, ".ssh", "config"), "utf8"),
    /BEGIN AgentPier/,
  );
});

test("a shell session without aliases leaves ~/.ssh/config untouched (R35)", async (t) => {
  const home = userHome(t);
  const f = withUserConfig(t, home);
  const { record } = await launch(f, { tool: "shell" });
  await f.agents.userConfig.idle();
  assert.equal(f.agents.status(record).state, "ready");
  assert.deepEqual(f.agents.status(record).aliases, {});
  assert.equal(fs.existsSync(path.join(home, ".ssh")), false);
  // An existing config stays byte for byte, and once a session gets an alias the
  // block is written and kept when that alias goes again.
  fs.mkdirSync(path.join(home, ".ssh"), { mode: 0o700 });
  const config = path.join(home, ".ssh", "config");
  fs.writeFileSync(config, "Host own\n  User me\n", { mode: 0o600 });
  await f.agents.sync(record);
  await f.agents.refresh();
  await f.agents.userConfig.idle();
  assert.equal(fs.readFileSync(config, "utf8"), "Host own\n  User me\n");
  await f.grants.set(record, ["access-a"]);
  await f.agents.sync(record);
  await f.agents.userConfig.idle();
  assert.match(fs.readFileSync(config, "utf8"), /^# BEGIN AgentPier /);
  await f.grants.set(record, []);
  await f.agents.sync(record);
  await f.agents.userConfig.idle();
  assert.match(fs.readFileSync(config, "utf8"), /^# BEGIN AgentPier [\s\S]*Host own\n/);
  assert.doesNotMatch(dispatcherOf(f), /originalhost/);
});

test("without a wired user config nothing outside the data folder is written", async (t) => {
  const f = fixture(t);
  await launch(f);
  assert.equal(fs.existsSync(path.join(f.dataDir, "ssh-agents", "include.conf")), false);
  assert.equal(fs.existsSync(path.join(f.deps.home, ".ssh")), false);
});
