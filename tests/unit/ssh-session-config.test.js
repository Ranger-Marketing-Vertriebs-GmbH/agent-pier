import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentHosts } from "../../server/features/ssh/ssh-agent-policy.js";
import {
  aliasBase,
  readSessionAliases,
  renderKnownHosts,
  renderSshConfig,
  renderWrapper,
  resolveOpenSshBinaries,
  sessionAliases,
  sessionFolder,
  writeSessionFiles,
} from "../../server/features/ssh/ssh-session-config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier ssh session config "));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

let counter = 0;
function publicLine() {
  counter += 1;
  const file = path.join(root, `key-${counter}`);
  execFileSync("ssh-keygen", ["-q", "-N", "", "-t", "ed25519", "-f", file]);
  const [kind, base64] = fs.readFileSync(`${file}.pub`, "utf8").trim().split(" ");
  return `${kind} ${base64}`;
}

const userKey = publicLine();
const hostKey = publicLine();
const id = "0a1b2c3d-0000-4000-8000-000000000001";

function access(fields) {
  counter += 1;
  return {
    id: `0a1b2c3d-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    type: "ssh",
    name: "Proxmox 2",
    host: "10.0.0.2",
    port: 2222,
    username: "deploy",
    keyId: "5f0e1d2c-0000-4000-8000-000000000001",
    publicKey: `${userKey} comment`,
    hostKey,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

function hostsOf(...accesses) {
  return agentHosts(
    accesses,
    accesses.map((row) => row.id),
  );
}

const older = hostsOf(access({ name: "db", createdAt: "2026-01-01T00:00:00.000Z" }))[0];
const newer = hostsOf(access({ name: "DB", createdAt: "2026-02-01T00:00:00.000Z" }))[0];

function tempFolder(name) {
  return fs.mkdtempSync(path.join(root, `${name} `));
}

test("aliases are DNS-safe slugs", () => {
  assert.equal(aliasBase("Proxmox 2 (Büro)", id), "proxmox-2-b-ro");
  assert.equal(aliasBase("web.example.com", id), "web-example-com");
  assert.equal(aliasBase("***", id), "host-0a1b2c3d");
  assert.equal(aliasBase("x".repeat(60), id).length, 40);
  assert.equal(aliasBase(`${"a".repeat(39)} b`, id), "a".repeat(39));
  assert.equal(
    aliasBase("evil\nHost *\nProxyCommand sh", id),
    "evil-host-proxycommand-sh",
  );
  assert.match(aliasBase(" -- ", id), /^host-0a1b2c3d$/);
});

test("collisions get suffixes by age and existing aliases never move", () => {
  const first = sessionAliases([newer, older]);
  assert.equal(first[older.accessId], "db");
  assert.equal(first[newer.accessId], "db-2");
  assert.deepEqual(Object.keys(first), [newer.accessId, older.accessId]);
  const later = sessionAliases([newer], first);
  assert.equal(later[newer.accessId], "db-2");
  const third = hostsOf(access({ name: "db", createdAt: "2025-01-01T00:00:00.000Z" }))[0];
  const again = sessionAliases([newer, older, third], first);
  assert.equal(again[older.accessId], "db");
  assert.equal(again[newer.accessId], "db-2");
  assert.equal(again[third.accessId], "db-3");
});

test("equal creation times fall back to the access id order", () => {
  const a = { ...older, accessId: "b-id" };
  const b = { ...older, accessId: "a-id" };
  assert.deepEqual(sessionAliases([a, b]), { "b-id": "db-2", "a-id": "db" });
});

test("a previous alias that is malformed or taken is not kept", () => {
  const aliases = sessionAliases([older, newer], {
    [older.accessId]: "Bad Alias",
    [newer.accessId]: "db",
  });
  assert.equal(aliases[newer.accessId], "db");
  assert.equal(aliases[older.accessId], "db-2");
});

function sampleInput(folder, extra = {}) {
  const hosts = hostsOf(access({ name: "Proxmox 2", ...extra }));
  return {
    hosts,
    aliases: sessionAliases(hosts),
    folder,
    socketPath: path.join(folder, "sock dir", "agent.sock"),
  };
}

test("ssh -G resolves an alias to the pinned, hardened options", () => {
  const folder = tempFolder("session");
  const tempHome = tempFolder("home");
  const { hosts, aliases, socketPath } = sampleInput(folder);
  writeSessionFiles(folder, {
    hosts,
    aliases,
    socketPath,
    binaries: resolveOpenSshBinaries(process.env.PATH),
  });
  // stderr is piped: OpenSSH 10 warns about the missing terminal even for -G.
  const sshOptions = { env: { HOME: tempHome, PATH: process.env.PATH }, stdio: "pipe" };
  const out = execFileSync(
    "ssh",
    ["-G", "-F", path.join(folder, "ssh_config"), "proxmox-2"],
    sshOptions,
  ).toString();
  for (const line of [
    "hostname 10.0.0.2",
    "port 2222",
    "user deploy",
    "hostkeyalias proxmox-2",
    "stricthostkeychecking true",
    "forwardagent no",
    "identitiesonly yes",
    "controlmaster false",
    "globalknownhostsfile /dev/null",
    "updatehostkeys false",
    "batchmode yes",
    "passwordauthentication no",
    "kbdinteractiveauthentication no",
    "preferredauthentications publickey",
    "permitlocalcommand no",
    "connecttimeout 10",
  ])
    assert.match(out, new RegExp(`^${line}$`, "m"));
  assert.match(out, /^identityagent .*agent\.sock$/m);
  assert.match(out, /^identityfile .*keys\/5f0e1d2c-0000-4000-8000-000000000001\.pub$/m);
  assert.match(out, /^userknownhostsfile .*known_hosts$/m);
  assert.doesNotMatch(out, /^proxy(jump|command) /m);
  const other = execFileSync(
    "ssh",
    ["-G", "-F", path.join(folder, "ssh_config"), "github.com"],
    sshOptions,
  ).toString();
  assert.match(other, /^hostname github\.com$/m);
  assert.doesNotMatch(other, /agent\.sock/);
  const userConfig = path.join(tempHome, "user_config");
  fs.writeFileSync(
    userConfig,
    `Match exec "true"\n  Include "${path.join(folder, "ssh_config")}"\nHost *\n  User someone\n`,
  );
  const included = (host) =>
    execFileSync("ssh", ["-G", "-F", userConfig, host], sshOptions).toString();
  assert.match(included("proxmox-2"), /^hostname 10\.0\.0\.2$/m);
  assert.match(included("proxmox-2"), /^user deploy$/m);
  assert.match(included("github.com"), /^user someone$/m);
  assert.doesNotMatch(included("github.com"), /agent\.sock/);
  assert.equal(
    fs.readFileSync(path.join(folder, "keys", `${hosts[0].keyId}.pub`), "utf8"),
    `${userKey}\n`,
  );
  assert.equal(
    fs.readFileSync(path.join(folder, "known_hosts"), "utf8"),
    `proxmox-2 ${hostKey}\n`,
  );
});

test("paths are double-quoted and escaped against tokens", () => {
  const config = renderSshConfig({
    ...sampleInput('/data/a %h \\ "q"'),
    socketPath: "/tmp/s %d/agent.sock",
  });
  assert.match(config, /^ {2}IdentityAgent "\/tmp\/s %%d\/agent\.sock"$/m);
  assert.match(
    config,
    /^ {2}UserKnownHostsFile "\/data\/a %%h \\\\ \\"q\\"\/known_hosts"$/m,
  );
  assert.throws(() =>
    renderSshConfig({ ...sampleInput("/data/${HOME}"), socketPath: "/tmp/a.sock" }),
  );
  assert.throws(() =>
    renderSshConfig({ ...sampleInput("/data/x"), socketPath: "/tmp/a\n.sock" }),
  );
  assert.throws(() => renderSshConfig({ ...sampleInput("relative"), socketPath: "/a" }));
});

test("legacy hosts add the two ssh-rsa options", () => {
  const legacyInput = sampleInput("/data/x", { legacyAlgorithms: true });
  assert.match(renderSshConfig(legacyInput), /PubkeyAcceptedAlgorithms \+ssh-rsa/);
  assert.match(renderSshConfig(legacyInput), /HostKeyAlgorithms \+ssh-rsa/);
  assert.doesNotMatch(renderSshConfig(sampleInput("/data/x")), /ssh-rsa/);
});

test("the config has no wildcard host and no include", () => {
  const input = sampleInput("/data/x");
  const config = renderSshConfig(input);
  assert.doesNotMatch(config, /^\s*(Host \*|Include|Match)/m);
  const lines = config.split("\n").filter(Boolean);
  assert.match(lines[0], /^Host proxmox-2$/);
  for (const line of lines.slice(1)) assert.match(line, /^(Host [a-z0-9-]+|  \S.*)$/);
});

test("host names with newlines cannot inject config lines", () => {
  const hosts = hostsOf(
    access({ name: "a\nHost *\n  ProxyCommand touch /tmp/pwned\nMatch all" }),
  );
  const input = { hosts, aliases: sessionAliases(hosts), folder: "/data/x" };
  const config = renderSshConfig({ ...input, socketPath: "/tmp/a.sock" });
  assert.match(config, /^Host a-host-proxycommand-touch-tmp-pwned-matc$/m);
  assert.doesNotMatch(config, /^\s*(Host \*|Match|ProxyCommand touch)/m);
  assert.equal(config.split("\n").filter((l) => l.startsWith("Host ")).length, 1);
});

test("hosts with unsafe endpoint fields or a forged alias are left out", () => {
  const hosts = [
    ...hostsOf(access({ name: "good" })),
    { ...hostsOf(access({ name: "evil host" }))[0], host: "x\n  ProxyCommand sh" },
    { ...hostsOf(access({ name: "evil user" }))[0], username: "root\nMatch all" },
    { ...hostsOf(access({ name: "evil key" }))[0], keyId: "../../identity" },
  ];
  const aliases = sessionAliases(hosts);
  const config = renderSshConfig({ hosts, aliases, folder: "/d", socketPath: "/s" });
  assert.deepEqual(
    config.split("\n").filter((l) => l.startsWith("Host ")),
    ["Host good"],
  );
  const forged = { [hosts[0].accessId]: "x\nHost *" };
  assert.equal(
    renderSshConfig({ hosts, aliases: forged, folder: "/d", socketPath: "/s" }),
    "",
  );
  assert.equal(renderKnownHosts({ hosts, aliases }), `good ${hostKey}\n`);
});

function recorder() {
  const folder = tempFolder("wrapper");
  const out = path.join(folder, "argv");
  const realPath = path.join(folder, "real ssh");
  fs.writeFileSync(
    realPath,
    `#!/bin/sh\nprintf '%s\\0' "$#" "$@" > ${JSON.stringify(out)}\n`,
    {
      mode: 0o700,
    },
  );
  const configPath = path.join(folder, 'it\'s $(id) "config"');
  const wrapper = path.join(folder, "ssh");
  fs.writeFileSync(
    wrapper,
    renderWrapper({ realPath, configPath, aliases: ["proxmox-2", "db"] }),
    { mode: 0o700 },
  );
  const run = (args) => {
    execFileSync(wrapper, args, { cwd: folder });
    const text = fs.readFileSync(out, "utf8");
    const [count, ...argv] = text.slice(0, -1).split("\0");
    assert.equal(argv.length, Number(count));
    return argv;
  };
  return { run, configPath, folder };
}

test("wrappers add -F only for session aliases", () => {
  const { run, configPath } = recorder();
  assert.deepEqual(run(["proxmox-2", "uptime"]), [
    "-F",
    configPath,
    "proxmox-2",
    "uptime",
  ]);
  assert.deepEqual(run(["-p", "22", "proxmox-2", "git-upload-pack 'r.git'"]), [
    "-F",
    configPath,
    "-p",
    "22",
    "proxmox-2",
    "git-upload-pack 'r.git'",
  ]);
  for (const target of [
    "db",
    "db:/tmp/x",
    "deploy@proxmox-2",
    "deploy@proxmox-2:/tmp/",
    "ssh://proxmox-2",
    "ssh://proxmox-2:2222",
    "ssh://proxmox-2/srv/r.git",
    "ssh://deploy@proxmox-2",
    "ssh://deploy@proxmox-2:2222/srv/r.git",
  ])
    assert.deepEqual(run(["file", target]).slice(0, 2), ["-F", configPath], target);
  for (const args of [
    ["github.com", "proxmox-2x"],
    ["git@github.com:org/proxmox-2.git"],
    ["proxmox-2.example.com"],
    ["ssh://proxmox-2.example.com/r.git"],
    ["xdb"],
    ["db@other"],
    [],
  ])
    assert.deepEqual(run(args), args);
});

test("wrappers pass hostile arguments through untouched", () => {
  const { run, configPath, folder } = recorder();
  const hostile = [
    "-oProxyCommand=touch pwned-a",
    "--",
    "with space",
    "it's",
    '"double"',
    "$(touch pwned-b)",
    "`touch pwned-c`",
    "a; touch pwned-d",
    "line\nbreak",
    "*",
    "",
    "-F",
  ];
  assert.deepEqual(run(hostile), hostile);
  assert.deepEqual(run([...hostile, "proxmox-2"]), [
    "-F",
    configPath,
    ...hostile,
    "proxmox-2",
  ]);
  assert.deepEqual(run(["$(touch pwned-e)@db"]), [
    "-F",
    configPath,
    "$(touch pwned-e)@db",
  ]);
  assert.deepEqual(
    fs.readdirSync(folder).filter((name) => name.startsWith("pwned")),
    [],
  );
});

test("wrapper scripts are plain sh without eval and refuse bad aliases", () => {
  const script = renderWrapper({
    realPath: "/usr/bin/ssh",
    configPath: "/c",
    aliases: ["proxmox-2"],
  });
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(script, /\beval\b/);
  assert.match(script, /exec "\$real" "\$@"\n$/);
  assert.throws(() =>
    renderWrapper({ realPath: "/usr/bin/ssh", configPath: "/c", aliases: ["a|*"] }),
  );
  assert.doesNotMatch(
    renderWrapper({ realPath: "/usr/bin/ssh", configPath: "/c", aliases: [] }),
    /case/,
  );
});

function fakeBinaries(names) {
  const dir = tempFolder("path");
  for (const name of names)
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

test("resolveOpenSshBinaries skips the session bin and returns what it finds", () => {
  const sessionBin = fakeBinaries(["ssh", "scp", "sftp"]);
  const linked = path.join(tempFolder("link"), "bin");
  fs.symlinkSync(sessionBin, linked);
  const partial = fakeBinaries(["ssh", "sftp"]);
  const later = fakeBinaries(["scp"]);
  const noExec = fakeBinaries([]);
  fs.writeFileSync(path.join(noExec, "ssh"), "", { mode: 0o644 });
  fs.mkdirSync(path.join(noExec, "scp"));
  const pathEnv = [
    "",
    ".",
    "relative/bin",
    linked,
    sessionBin,
    noExec,
    partial,
    later,
  ].join(":");
  assert.deepEqual(resolveOpenSshBinaries(pathEnv, [sessionBin]), {
    ssh: path.join(partial, "ssh"),
    scp: path.join(later, "scp"),
    sftp: path.join(partial, "sftp"),
  });
  assert.deepEqual(resolveOpenSshBinaries(partial), {
    ssh: path.join(partial, "ssh"),
    sftp: path.join(partial, "sftp"),
  });
  assert.equal(resolveOpenSshBinaries(later), null);
  assert.equal(
    resolveOpenSshBinaries([sessionBin, linked].join(":"), [sessionBin]),
    null,
  );
  assert.equal(resolveOpenSshBinaries(""), null);
  assert.equal(resolveOpenSshBinaries(undefined), null);
});

test("files are private and written by rename", () => {
  const dataDir = tempFolder("data");
  const folder = sessionFolder(dataDir, "session-one");
  assert.equal(folder, path.join(dataDir, "ssh", "agents", "session-one"));
  const { hosts, aliases, socketPath } = sampleInput(folder);
  const real = fakeBinaries(["ssh", "scp"]);
  const binaries = resolveOpenSshBinaries(real);
  writeSessionFiles(folder, { hosts, aliases, socketPath, binaries });
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  for (const name of ["ssh_config", "known_hosts", "aliases.json"])
    assert.equal(fs.statSync(path.join(folder, name)).mode & 0o777, 0o600, name);
  for (const dir of ["bin", "keys"])
    assert.equal(fs.statSync(path.join(folder, dir)).mode & 0o777, 0o700, dir);
  assert.equal(
    fs.statSync(path.join(folder, "keys", `${hosts[0].keyId}.pub`)).mode & 0o777,
    0o600,
  );
  assert.equal(fs.statSync(path.join(folder, "bin", "ssh")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(folder, "bin", "scp")).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.join(folder, "bin")).sort(), ["scp", "ssh"]);
  assert.match(fs.readFileSync(path.join(folder, "bin", "ssh"), "utf8"), /\bproxmox-2\|/);
  for (const dir of [folder, path.join(folder, "bin"), path.join(folder, "keys")])
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.includes(".tmp")),
      [],
    );
  assert.deepEqual(readSessionAliases(dataDir, "session-one"), aliases);
});

test("rewriting drops wrappers and keys that are no longer needed", () => {
  const folder = sessionFolder(tempFolder("data"), "session-two");
  const { hosts, aliases, socketPath } = sampleInput(folder);
  const real = fakeBinaries(["ssh", "scp", "sftp"]);
  writeSessionFiles(folder, {
    hosts,
    aliases,
    socketPath,
    binaries: resolveOpenSshBinaries(real),
  });
  writeSessionFiles(folder, {
    hosts: [],
    aliases: {},
    socketPath,
    binaries: { ssh: path.join(real, "ssh") },
  });
  assert.deepEqual(fs.readdirSync(path.join(folder, "bin")), ["ssh"]);
  assert.deepEqual(fs.readdirSync(path.join(folder, "keys")), []);
  assert.equal(fs.readFileSync(path.join(folder, "ssh_config"), "utf8"), "");
  assert.doesNotMatch(fs.readFileSync(path.join(folder, "bin", "ssh"), "utf8"), /case/);
});

test("a duplicate alias is rendered once and a bad path writes nothing", () => {
  const hosts = hostsOf(access({ name: "one" }), access({ name: "two" }));
  const aliases = { [hosts[0].accessId]: "same", [hosts[1].accessId]: "same" };
  const config = renderSshConfig({ hosts, aliases, folder: "/d", socketPath: "/s" });
  assert.equal(config.split("\n").filter((l) => l.startsWith("Host ")).length, 1);
  assert.equal(renderKnownHosts({ hosts, aliases }).split("\n").length, 2);
  const folder = path.join(tempFolder("data"), "${HOME}");
  assert.throws(() =>
    writeSessionFiles(folder, { hosts, aliases, socketPath: "/s", binaries: null }),
  );
  assert.equal(fs.existsSync(folder), false);
});

test("session ids are validated before they name a folder", () => {
  for (const bad of ["../x", "", "-x", "a/b", ".", "x".repeat(121), 7, null])
    assert.throws(() => sessionFolder("/data", bad), String(bad));
  assert.doesNotThrow(() => sessionFolder("/data", `a${"b".repeat(119)}`));
});

test("readSessionAliases tolerates a missing or broken file", () => {
  const dataDir = tempFolder("data");
  assert.deepEqual(readSessionAliases(dataDir, "missing"), {});
  assert.deepEqual(readSessionAliases(dataDir, "../x"), {});
  const folder = sessionFolder(dataDir, "broken");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "aliases.json"), "{not json");
  assert.deepEqual(readSessionAliases(dataDir, "broken"), {});
  fs.writeFileSync(path.join(folder, "aliases.json"), "[1]");
  assert.deepEqual(readSessionAliases(dataDir, "broken"), {});
  fs.writeFileSync(
    path.join(folder, "aliases.json"),
    JSON.stringify({ a: "ok-alias", b: "Bad\nHost *", c: 3 }),
  );
  assert.deepEqual(readSessionAliases(dataDir, "broken"), { a: "ok-alias" });
});
