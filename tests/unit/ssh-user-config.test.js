// The ~/.ssh/config block writer, always against a stand-in home under the OS temp
// folder; the real ~/.ssh is never read or written.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SSH_CONFIG_BACKUP,
  includeWord,
  installSshConfigInclude,
  removeSshConfigInclude,
  renderDispatcher,
  renderIncludeBlock,
  sshConfigKey,
} from "../../server/features/ssh/ssh-user-config.js";

function fakeHome(t, name = "home") {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ssh-user-config-")),
  );
  t.after(() => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, name);
  fs.mkdirSync(home, { mode: 0o700 });
  assert.notEqual(home, os.homedir());
  return { root, home, config: path.join(home, ".ssh", "config") };
}

const key = "abcd1234";
const otherKey = "0f0f0f0f";
const dispatcher = "/data/ssh-agents/include.conf";
const block = renderIncludeBlock(dispatcher, key);
const other = renderIncludeBlock("/spike/ssh-agents/include.conf", otherKey);
const mode = (file) => fs.statSync(file).mode & 0o777;
const install = (home, extra = {}) =>
  installSshConfigInclude({ home, dispatcher, key, ...extra });

test("the block is keyed by its data folder, shell-neutral and ends with Match all", () => {
  assert.equal(
    block,
    [
      "# BEGIN AgentPier abcd1234 (managed, do not edit)",
      'Match exec "printenv AGENTPIER_SSH_CONFIG >/dev/null"',
      '  Include "/data/ssh-agents/include.con[f]"',
      "Match all",
      "# END AgentPier abcd1234",
      "",
    ].join("\n"),
  );
  assert.match(sshConfigKey("/data"), /^[0-9a-f]{8}$/);
  assert.notEqual(sshConfigKey("/data"), sshConfigKey("/spike"));
  assert.throws(() => renderIncludeBlock(dispatcher, "../x"), {
    code: "SSH_CONFIG_PATH_UNSUPPORTED",
  });
});

test("include paths escape glob characters and refuse what cannot stay literal", () => {
  assert.equal(
    includeWord("/a b/c*d?e[f]/ssh_config"),
    '"/a b/c\\*d\\?e\\[f\\]/ssh_confi[g]"',
  );
  for (const bad of [
    "relative/ssh_config",
    "/a\\b/ssh_config",
    '/a"b/ssh_config',
    "/a$b/ssh_config",
    "/a${HOME}/ssh_config",
    "/a%d/ssh_config",
    "/a`id`/ssh_config",
    "/a'b/ssh_config",
    "/a!b/ssh_config",
    "/a\nb/ssh_config",
  ])
    assert.throws(() => includeWord(bad), { code: "SSH_CONFIG_PATH_UNSUPPORTED" }, bad);
});

test("the dispatcher names each session's aliases before a shell-neutral check", () => {
  const text = renderDispatcher([
    { configPath: "/d a/ssh-agents/s1/ssh_config", aliases: ["proxmox-2", "build"] },
    { configPath: "/d a/ssh-agents/s2/ssh_config", aliases: [] },
    { configPath: "/d a/ssh-agents/s3/ssh_config", aliases: ["-bad", "ok"] },
  ]);
  assert.equal(
    text,
    [
      "# Managed by AgentPier: the aliases of each session's SSH agent.",
      "Match originalhost proxmox-2,build exec \"printenv AGENTPIER_SSH_CONFIG | grep -qxF -- '/d a/ssh-agents/s1/ssh_config'\"",
      '  Include "/d a/ssh-agents/s1/ssh_confi[g]"',
      "Match originalhost ok exec \"printenv AGENTPIER_SSH_CONFIG | grep -qxF -- '/d a/ssh-agents/s3/ssh_config'\"",
      '  Include "/d a/ssh-agents/s3/ssh_confi[g]"',
      "",
    ].join("\n"),
  );
});

test("a missing ~/.ssh and config are created private", (t) => {
  const { home, config } = fakeHome(t);
  assert.equal(install(home), "written");
  assert.equal(mode(path.dirname(config)), 0o700);
  assert.equal(mode(config), 0o600);
  assert.equal(fs.readFileSync(config, "utf8"), block);
  assert.equal(fs.existsSync(path.join(home, ".ssh", SSH_CONFIG_BACKUP)), false);
});

test("the block goes on top once, other lines and the mode stay, a backup is kept", (t) => {
  const { home, config } = fakeHome(t);
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  const own = "Host *.corp\r\n  User me\n\n# trailing comment without newline";
  fs.writeFileSync(config, own, { mode: 0o644 });
  fs.chmodSync(config, 0o644);
  assert.equal(install(home), "written");
  assert.equal(fs.readFileSync(config, "utf8"), block + own);
  assert.equal(mode(config), 0o644);
  const backup = path.join(home, ".ssh", SSH_CONFIG_BACKUP);
  assert.equal(fs.readFileSync(backup, "utf8"), own);
  const inode = fs.statSync(config).ino;
  assert.equal(install(home), "unchanged");
  assert.equal(fs.statSync(config).ino, inode);
  // A block the user moved down goes back to the top; the first backup stays.
  fs.writeFileSync(config, own + "\n" + block + "Host x\n");
  assert.equal(install(home), "written");
  assert.equal(fs.readFileSync(config, "utf8"), block + own + "\nHost x\n");
  assert.equal(fs.readFileSync(backup, "utf8"), own);
  assert.equal(
    fs.readdirSync(path.dirname(config)).filter((n) => n.endsWith(".tmp")).length,
    0,
  );
});

test("instances with other data folders keep their own blocks", (t) => {
  const { home, config } = fakeHome(t);
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  fs.writeFileSync(config, "Host mine\n", { mode: 0o600 });
  install(home);
  installSshConfigInclude({
    home,
    dispatcher: "/spike/ssh-agents/include.conf",
    key: otherKey,
  });
  assert.equal(fs.readFileSync(config, "utf8"), other + block + "Host mine\n");
  // A moved data folder of the same instance replaces its own block only.
  install(home, { dispatcher: "/moved/ssh-agents/include.conf" });
  const text = fs.readFileSync(config, "utf8");
  assert.equal(text.split("# BEGIN AgentPier abcd1234").length, 2);
  assert.match(text, /moved\/ssh-agents/);
  assert.ok(text.includes(other));
  assert.equal(removeSshConfigInclude({ home, key: otherKey }), "removed");
  assert.equal(
    fs.readFileSync(config, "utf8"),
    renderIncludeBlock("/moved/ssh-agents/include.conf", key) + "Host mine\n",
  );
});

test("a linked, foreign, unreadable or damaged config is left alone", (t) => {
  const { root, home, config } = fakeHome(t);
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  const target = path.join(root, "elsewhere");
  fs.writeFileSync(target, "Host a\n");
  fs.symlinkSync(target, config);
  assert.throws(() => install(home), { code: "SSH_CONFIG_LINK" });
  assert.equal(fs.readFileSync(target, "utf8"), "Host a\n");
  assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
  fs.rmSync(config);
  fs.linkSync(target, config);
  assert.throws(() => install(home), { code: "SSH_CONFIG_LINK" });
  assert.equal(fs.readFileSync(target, "utf8"), "Host a\n");
  fs.rmSync(config);
  fs.mkdirSync(config);
  assert.throws(() => install(home), { code: "SSH_CONFIG_NOT_FILE" });
  fs.rmdirSync(config);
  fs.writeFileSync(config, `Host a\n${block.split("\n")[0]}\nMatch all\n`);
  assert.throws(() => install(home), { code: "SSH_CONFIG_BLOCK_DAMAGED" });
  assert.throws(() => install(home, { dispatcher: "/a$b/x.conf" }), {
    code: "SSH_CONFIG_PATH_UNSUPPORTED",
  });
  if (process.getuid?.() !== 0) {
    fs.writeFileSync(config, "Host a\n");
    fs.chmodSync(config, 0o000);
    assert.throws(() => install(home), { code: "SSH_CONFIG_UNREADABLE" });
    fs.chmodSync(config, 0o600);
    assert.equal(fs.readFileSync(config, "utf8"), "Host a\n");
  }
  assert.equal(fs.existsSync(path.join(home, ".ssh", SSH_CONFIG_BACKUP)), false);
});

test("removal takes out only the block and keeps the mode and the backup", (t) => {
  const { home, config } = fakeHome(t);
  assert.equal(removeSshConfigInclude({ home, key }), "absent");
  assert.equal(fs.existsSync(path.join(home, ".ssh")), false);
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  fs.writeFileSync(config, "Port 2222\n", { mode: 0o640 });
  fs.chmodSync(config, 0o640);
  assert.equal(removeSshConfigInclude({ home, key }), "absent");
  install(home);
  assert.equal(removeSshConfigInclude({ home, key }), "removed");
  assert.equal(fs.readFileSync(config, "utf8"), "Port 2222\n");
  assert.equal(mode(config), 0o640);
  assert.equal(
    fs.readFileSync(path.join(home, ".ssh", SSH_CONFIG_BACKUP), "utf8"),
    "Port 2222\n",
  );
  fs.rmSync(config);
  fs.symlinkSync("/dev/null", config);
  assert.throws(() => removeSshConfigInclude({ home, key }), {
    code: "SSH_CONFIG_LINK",
  });
});

test("a config AgentPier created is deleted when its block goes, ~/.ssh stays", (t) => {
  const { home, config } = fakeHome(t);
  install(home);
  assert.equal(removeSshConfigInclude({ home, key }), "removed");
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.statSync(path.dirname(config)).isDirectory(), true);
  // An empty file the user had (a backup exists) stays.
  fs.writeFileSync(config, "", { mode: 0o600 });
  install(home);
  assert.equal(removeSshConfigInclude({ home, key }), "removed");
  assert.equal(fs.readFileSync(config, "utf8"), "");
});

test("the removal script takes out this data folder's block only", async (t) => {
  const { runSshConfig } = await import("../../scripts/ssh-config.mjs");
  const { root, home, config } = fakeHome(t);
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  fs.writeFileSync(config, "Host mine\n", { mode: 0o600 });
  installSshConfigInclude({ home, dispatcher, key: sshConfigKey(dataDir) });
  installSshConfigInclude({
    home,
    dispatcher: "/spike/ssh-agents/include.conf",
    key: otherKey,
  });
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(runSshConfig({ action: "remove", home, dataDir, log }), 0);
  assert.equal(fs.readFileSync(config, "utf8"), other + "Host mine\n");
  assert.equal(runSshConfig({ action: "remove", home, dataDir, log }), 0);
  assert.match(lines[0], /entfernt/);
  assert.match(lines[1], /keinen AgentPier-Block/);
  fs.rmSync(config);
  fs.symlinkSync("/dev/null", config);
  assert.equal(runSshConfig({ action: "remove", home, dataDir, log }), 1);
  assert.match(lines[2], /SSH_CONFIG_LINK/);
  assert.throws(
    () => runSshConfig({ action: "install", home, dataDir, log }),
    /ssh-config\.mjs remove/,
  );
});
