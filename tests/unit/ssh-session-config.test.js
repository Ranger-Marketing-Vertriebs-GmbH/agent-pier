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

function fakeBinaries(names) {
  const dir = tempFolder("path");
  for (const name of names)
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

test("files are private and written by rename", () => {
  const dataDir = tempFolder("data");
  const folder = sessionFolder(dataDir, "session-one");
  assert.equal(folder, path.join(dataDir, "ssh-agents", "session-one"));
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

test("digit-only and loopback aliases get a prefix and suffixes stay within 40", () => {
  assert.equal(aliasBase("22", id), "host-22");
  assert.equal(aliasBase("Localhost", id), "host-localhost");
  assert.equal(aliasBase("10.0.0.2", id), "10-0-0-2");
  const long = "x".repeat(60);
  const hosts = [1, 2, 3].map(
    (n) => hostsOf(access({ name: long, createdAt: `2026-0${n}-01` }))[0],
  );
  const aliases = Object.values(sessionAliases(hosts));
  assert.deepEqual(aliases, [
    "x".repeat(40),
    `${"x".repeat(38)}-2`,
    `${"x".repeat(38)}-3`,
  ]);
  const dashed = hostsOf(
    access({ name: `${"y".repeat(38)}-z` }),
    access({ name: `${"y".repeat(38)}-z` }),
  );
  for (const alias of Object.values(sessionAliases(dashed)))
    assert.match(alias, /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
  assert.equal(Object.values(sessionAliases(dashed))[1], `${"y".repeat(38)}-2`);
  const kept = sessionAliases(hosts.slice(0, 1), { [hosts[0].accessId]: "22" });
  assert.equal(kept[hosts[0].accessId], "x".repeat(40));
  assert.deepEqual(
    sessionAliases(hosts.slice(0, 1), { [hosts[0].accessId]: "localhost" }),
    { [hosts[0].accessId]: "x".repeat(40) },
  );
});

test("a percent sign in HostName (IPv6 zone) is escaped", () => {
  const folder = tempFolder("zone");
  const hosts = hostsOf(access({ name: "link local", host: "fe80::1%en0" }));
  const aliases = sessionAliases(hosts);
  const socketPath = path.join(folder, "agent.sock");
  const { skipped } = writeSessionFiles(folder, {
    hosts,
    aliases,
    socketPath,
    binaries: {},
  });
  assert.deepEqual(skipped, []);
  assert.match(
    fs.readFileSync(path.join(folder, "ssh_config"), "utf8"),
    /HostName fe80::1%%en0/,
  );
  const out = execFileSync(
    "ssh",
    ["-G", "-F", path.join(folder, "ssh_config"), "link-local"],
    { env: { HOME: folder, PATH: process.env.PATH }, stdio: "pipe" },
  ).toString();
  assert.match(out, /^hostname fe80::1%en0$/m);
});

test("writeSessionFiles reports the hosts it could not render", () => {
  const good = hostsOf(access({ name: "good" }))[0];
  const bad = { ...hostsOf(access({ name: "bad" }))[0], username: "root\nMatch all" };
  const unaliased = hostsOf(access({ name: "none" }))[0];
  const aliases = { ...sessionAliases([good, bad]) };
  const folder = tempFolder("skipped");
  const result = writeSessionFiles(folder, {
    hosts: [good, bad, unaliased],
    aliases,
    socketPath: "/tmp/agent.sock",
    binaries: {},
  });
  assert.deepEqual(result, { skipped: [bad.accessId, unaliased.accessId] });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(folder, "aliases.json"), "utf8")),
    {
      [good.accessId]: "good",
    },
  );
});

function victim() {
  const dir = tempFolder("victim");
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, "precious"), "keep\n", { mode: 0o644 });
  fs.chmodSync(path.join(dir, "precious"), 0o644);
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", "deep"), "keep\n");
  const untouched = () => {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nested", "precious"]);
    assert.equal(fs.readFileSync(path.join(dir, "precious"), "utf8"), "keep\n");
    assert.equal(fs.statSync(path.join(dir, "precious")).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(path.join(dir, "nested")), ["deep"]);
  };
  return { dir, untouched };
}

function writeInto(folder) {
  const { hosts, aliases, socketPath } = sampleInput(folder);
  const binaries = resolveOpenSshBinaries(fakeBinaries(["ssh", "scp", "sftp"]));
  return () => writeSessionFiles(folder, { hosts, aliases, socketPath, binaries });
}

test("planted symlinks for bin, keys or the session folder are refused", () => {
  for (const planted of ["bin", "keys", "session", "ssh-agents"]) {
    const target = victim();
    const folder = path.join(tempFolder("planted"), "ssh-agents", "session");
    const link = {
      bin: path.join(folder, "bin"),
      keys: path.join(folder, "keys"),
      session: folder,
      "ssh-agents": path.dirname(folder),
    }[planted];
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target.dir, link);
    assert.throws(writeInto(folder), { code: "SSH_FOLDER_UNSAFE" }, planted);
    target.untouched();
  }
});

test("a folder swapped for a link after the check stops the write", (t) => {
  for (const swapped of ["keys", "session"]) {
    const target = victim();
    const folder = path.join(tempFolder("swap"), "session");
    const write = writeInto(folder);
    write();
    fs.symlinkSync(path.join(target.dir, "precious"), path.join(folder, "keys", "stray"));
    const dir = swapped === "keys" ? path.join(folder, "keys") : folder;
    const rename = fs.renameSync;
    let done = false;
    t.mock.method(fs, "renameSync", (from, to) => {
      rename(from, to);
      if (done || !to.endsWith(".pub")) return;
      done = true;
      rename(dir, `${dir}-moved`);
      fs.symlinkSync(swapped === "keys" ? target.dir : path.dirname(target.dir), dir);
    });
    assert.throws(write, { code: "SSH_FOLDER_UNSAFE" }, swapped);
    t.mock.restoreAll();
    assert.equal(done, true);
    target.untouched();
  }
});

test("stray links inside the folders are unlinked, never followed", () => {
  const target = victim();
  const folder = path.join(tempFolder("stray"), "session");
  const write = writeInto(folder);
  write();
  fs.symlinkSync(target.dir, path.join(folder, "bin", "dir-link"));
  fs.symlinkSync(
    path.join(target.dir, "precious"),
    path.join(folder, "keys", "file-link"),
  );
  fs.mkdirSync(path.join(folder, "bin", "real-dir"));
  fs.rmSync(path.join(folder, "ssh_config"));
  fs.symlinkSync(path.join(target.dir, "precious"), path.join(folder, "ssh_config"));
  fs.rmSync(path.join(folder, "bin", "ssh"));
  fs.symlinkSync(path.join(target.dir, "precious"), path.join(folder, "bin", "ssh"));
  write();
  target.untouched();
  assert.deepEqual(fs.readdirSync(path.join(folder, "bin")).sort(), [
    "real-dir",
    "scp",
    "sftp",
    "ssh",
  ]);
  assert.equal(fs.lstatSync(path.join(folder, "bin", "ssh")).isFile(), true);
  assert.equal(fs.lstatSync(path.join(folder, "ssh_config")).isFile(), true);
  assert.deepEqual(fs.readdirSync(path.join(folder, "keys")).length, 1);
});

test("readSessionAliases does not follow a planted aliases.json link", () => {
  const dataDir = tempFolder("data");
  const folder = sessionFolder(dataDir, "linked");
  fs.mkdirSync(folder, { recursive: true });
  const outside = path.join(tempFolder("outside"), "aliases.json");
  fs.writeFileSync(outside, JSON.stringify({ a: "outside" }));
  fs.symlinkSync(outside, path.join(folder, "aliases.json"));
  assert.deepEqual(readSessionAliases(dataDir, "linked"), {});
});
