import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderWrapper } from "../../server/features/ssh/ssh-session-config.js";

// Owner A18: an agent's own ssh and scp wrappers refuse options that run a local
// program (Always allow lets them run without a card); session wrappers do not.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier agent ssh wrappers "));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const dash = ["/bin/dash", "/usr/bin/dash"].find((file) => fs.existsSync(file));
const shells = [null, ...(dash ? [dash] : [])];

function wrapper(tool, { strict = true, aliases = ["proxmox-2", "db"] } = {}) {
  const folder = fs.mkdtempSync(path.join(root, `${tool} `));
  const out = path.join(folder, "argv");
  const realPath = path.join(folder, `real ${tool}`);
  fs.writeFileSync(
    realPath,
    `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(out)}\n`,
    { mode: 0o700 },
  );
  const file = path.join(folder, tool);
  const configPath = path.join(folder, "ssh_config");
  fs.writeFileSync(file, renderWrapper({ tool, realPath, configPath, aliases, strict }), {
    mode: 0o700,
  });
  // { code, stderr, argv }: argv is null when the real binary never ran.
  const run = (args) => {
    let first;
    for (const shell of shells) {
      fs.rmSync(out, { force: true });
      const result = shell
        ? spawnSync(shell, [file, ...args], { cwd: folder, encoding: "utf8" })
        : spawnSync(file, args, { cwd: folder, encoding: "utf8" });
      const argv = fs.existsSync(out)
        ? fs.readFileSync(out, "utf8").split("\0").slice(0, -1)
        : null;
      const outcome = { code: result.status, stderr: result.stderr, argv };
      if (first) assert.deepEqual(outcome, first, `${shell} differs`);
      first = outcome;
    }
    return first;
  };
  return { run, configPath, folder };
}

const hostileSsh = [
  ["-o", "ProxyCommand=touch pwned-a", "db"],
  ["-oProxyCommand=touch pwned-b", "github.com"],
  ["-o", "proxycommand touch pwned-c", "db"],
  ["-o", "  PROXYCOMMAND = touch pwned-d", "db"],
  ["-vo", "LocalCommand=touch pwned-e", "db"],
  ["-o", "PermitLocalCommand=yes", "db"],
  ["-o", "KnownHostsCommand=touch pwned-f", "db"],
  ["-o", "ProxyUseFdpass=yes", "db"],
  ["-o", "Match exec touch pwned-g", "db"],
  ["-o", "PKCS11Provider=/tmp/pwned.so", "db"],
  ["-o", "SecurityKeyProvider=/tmp/pwned.so", "db"],
  ["-F", "/tmp/evil_config", "db"],
  ["-F/tmp/evil_config", "db"],
  ["-vF", "/tmp/evil_config", "db"],
  ["-I", "/tmp/pwned.so", "db"],
  ["db", "-o", "ProxyCommand=touch pwned-h"],
  ["github.com", "-F", "/tmp/evil_config"],
];

test("the agent's ssh refuses local-command options and never runs ssh", () => {
  for (const aliases of [["proxmox-2", "db"], []]) {
    const { run, folder } = wrapper("ssh", { aliases });
    for (const args of hostileSsh) {
      const { code, stderr, argv } = run(args);
      assert.notEqual(code, 0, args.join(" "));
      assert.equal(argv, null, args.join(" "));
      assert.match(stderr, /^AgentPier: .+ is not allowed in this agent's ssh\.\n$/);
    }
    assert.deepEqual(
      fs.readdirSync(folder).filter((name) => name.startsWith("pwned")),
      [],
    );
  }
});

test("the agent's ssh keeps jumps, harmless options and remote commands", () => {
  const { run, configPath } = wrapper("ssh");
  for (const args of [
    ["-J", "db", "github.com"],
    ["-o", "ProxyJump=db", "github.com"],
    ["-o", "BatchMode=yes", "db", "uptime"],
    ["-l", "ProxyCommand", "github.com"],
    ["-o", "ProxyCommandX=1", "github.com"],
    ["db", "ssh", "-F", "x", "-o", "ProxyCommand=y", "z"],
    ["--", "db", "-F", "x"],
    ["github.com", "uptime"],
  ]) {
    const { code, argv } = run(args);
    assert.equal(code, 0, args.join(" "));
    assert.ok(argv, args.join(" "));
    assert.deepEqual(argv.slice(-args.length), args);
  }
  assert.deepEqual(run(["db"]).argv, ["-F", configPath, "db"]);
  // Its own config, as the agent's guidance names it, stays allowed.
  assert.deepEqual(run(["-F", configPath, "db"]).argv, ["-F", configPath, "db"]);
  assert.deepEqual(run([`-F${configPath}`, "db"]).argv, [`-F${configPath}`, "db"]);
  assert.equal(run(["-F", `${configPath}x`, "db"]).code, 2);
});

test("the agent's scp refuses a transport program and local-command options", () => {
  const { run, folder } = wrapper("scp");
  for (const args of [
    ["-S", "/tmp/pwned", "a", "db:/x"],
    ["-S/tmp/pwned", "a", "github.com:/x"],
    ["-rS", "/tmp/pwned", "a", "db:/x"],
    ["-o", "ProxyCommand=touch pwned-a", "a", "db:/x"],
    ["-oLocalCommand=touch pwned-b", "a", "db:/x"],
    ["-o", "knownhostscommand touch pwned-c", "a", "db:/x"],
    ["-F", "/tmp/evil_config", "a", "db:/x"],
  ]) {
    const { code, stderr, argv } = run(args);
    assert.notEqual(code, 0, args.join(" "));
    assert.equal(argv, null, args.join(" "));
    assert.match(stderr, /^AgentPier: .+ is not allowed in this agent's scp\.\n$/);
  }
  for (const args of [
    ["-J", "db", "a", "github.com:/x"],
    ["-o", "ProxyJump=db", "a", "github.com:/x"],
    ["-P", "2222", "a", "db:/x"],
    ["a", "db:-S"],
  ])
    assert.equal(run(args).code, 0, args.join(" "));
  assert.deepEqual(
    fs.readdirSync(folder).filter((name) => name.startsWith("pwned")),
    [],
  );
});

test("session wrappers and the agent's sftp pass those options through", () => {
  for (const tool of ["ssh", "scp"]) {
    const { run } = wrapper(tool, { strict: false });
    const args = ["-F", "/tmp/own_config", "-o", "ProxyCommand=true", "a", "db:/x"];
    assert.deepEqual(run(args).argv, args);
  }
  const { run } = wrapper("sftp");
  const args = ["-o", "ProxyCommand=true", "-S", "/x", "db"];
  assert.equal(run(args).code, 0);
  assert.deepEqual(run(args).argv.slice(-args.length), args);
});
