import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const hostFile = path.join(dataDir, "host");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostFile]);
  const hostKey = fs.readFileSync(`${hostFile}.pub`, "utf8").trim();
  return {
    dataDir,
    hostFile,
    store: new SshAccessStore({ dataDir, ...options }),
    input: {
      name: "Development",
      host: "example.test",
      port: 2222,
      username: "deploy",
      hostKey,
    },
  };
}

test("generated keys persist privately and public projections never expose private material", async (t) => {
  const { store, input, dataDir } = fixture(t);
  const access = await store.create(input);
  assert.match(access.publicKey, /^ssh-ed25519 /);
  assert.match(access.fingerprint, /^SHA256:/);
  assert.match(access.hostFingerprint, /^SHA256:/);
  const connection = store.connection(access.id);
  const keyFile = path.resolve(
    connection.cwd,
    connection.args[connection.args.indexOf("-i") + 1],
  );
  const secret = fs.readFileSync(keyFile, "utf8");
  assert.match(secret, /BEGIN OPENSSH PRIVATE KEY/);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(keyFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dataDir, "ssh/accesses.json")).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(store.list()).includes(secret));
  assert.ok(!JSON.stringify(store.get(access.id)).includes("PRIVATE KEY"));
  assert.deepEqual(new SshAccessStore({ dataDir }).get(access.id), access);
  store.remove(access.id);
  assert.equal(fs.existsSync(keyFile), false);
  assert.throws(() => store.get(access.id), { status: 404 });
});

test("connection disables inherited config, agent, multiplexing and interactive authentication", async (t) => {
  const { store, input } = fixture(t);
  const access = await store.create(input);
  const { command, args, cwd } = store.connection(access.id);
  assert.equal(command, "ssh");
  assert.deepEqual(args.slice(0, 2), ["-F", "/dev/null"]);
  for (const option of [
    "IdentityAgent=none",
    "IdentitiesOnly=yes",
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "GlobalKnownHostsFile=/dev/null",
    "ForwardAgent=no",
    "ControlMaster=no",
    "ControlPath=none",
  ])
    assert.ok(args.includes(option), option);
  assert.equal(args.at(-1), "example.test");
  assert.equal(args[args.indexOf("-p") + 1], "2222");
  assert.equal(args[args.indexOf("-l") + 1], "deploy");
  const knownHosts = args
    .find((arg) => arg.startsWith("UserKnownHostsFile="))
    .split("=")
    .slice(1)
    .join("=")
    .replace(/^"|"$/g, "");
  assert.match(
    fs.readFileSync(path.resolve(cwd, knownHosts), "utf8"),
    /^\[example.test\]:2222 ssh-ed25519 /,
  );
});

test("rejects malformed endpoints, option injection and invalid host keys before saving", async (t) => {
  const { store, input } = fixture(t);
  for (const patch of [
    { host: "-oProxyCommand=bad" },
    { host: "foo\nbar" },
    { host: "a b" },
    { username: "-root" },
    { username: "root@elsewhere" },
    { port: 0 },
    { port: "22oops" },
    { port: 65536 },
    { hostKey: "ssh-ed25519 AAAA" },
    { hostKey: `${input.hostKey}\n${input.hostKey}` },
    { privateKey: "TOP SECRET INVALID KEY" },
  ]) {
    await assert.rejects(
      store.create({ ...input, ...patch }),
      (error) => error.status === 400 && !error.message.includes("TOP SECRET"),
    );
  }
  assert.deepEqual(store.list(), []);
});

test("imports unencrypted keys and requires host reconfirmation when endpoint changes", async (t) => {
  const { store, input, hostFile } = fixture(t);
  const access = await store.create({
    ...input,
    privateKey: fs.readFileSync(hostFile, "utf8"),
  });
  assert.equal(access.publicKey.split(" ")[1], input.hostKey.split(" ")[1]);
  await assert.rejects(store.update(access.id, { host: "other.test" }), { status: 400 });
  assert.equal(store.get(access.id).host, "example.test");
  const updated = await store.update(access.id, {
    host: "other.test",
    hostKey: input.hostKey,
    name: "Renamed",
  });
  assert.equal(updated.name, "Renamed");
  assert.equal(store.connection(access.id).args.at(-1), "other.test");
});

test("pasted OpenSSH keys tolerate missing final newline, CRLF and surrounding whitespace", async (t) => {
  const { store, input, hostFile } = fixture(t);
  const original = fs.readFileSync(hostFile, "utf8");
  for (const privateKey of [
    original.trimEnd(),
    original.replaceAll("\n", "\r\n"),
    "\n  " + original + "  \n",
    original.replaceAll("\n", "\r"),
  ]) {
    const access = await store.create({ ...input, privateKey });
    assert.equal(access.publicKey.split(" ")[1], input.hostKey.split(" ")[1]);
    const connection = store.connection(access.id);
    const stored = fs.readFileSync(path.join(connection.cwd, "identity"), "utf8");
    assert.equal(stored.endsWith("\n"), true);
    assert.equal(stored.includes("\r"), false);
    assert.equal(fs.statSync(path.join(connection.cwd, "identity")).mode & 0o777, 0o600);
  }
});

test("rejects encrypted private keys without prompting and removes failed material", async (t) => {
  const { store, input, dataDir } = fixture(t);
  const encrypted = path.join(dataDir, "encrypted");
  execFileSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "secret-passphrase",
    "-f",
    encrypted,
  ]);
  await assert.rejects(
    store.create({ ...input, privateKey: fs.readFileSync(encrypted, "utf8") }),
    { status: 400 },
  );
  assert.deepEqual(store.list(), []);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "ssh/keys")), []);
});

test("scan and connection test run only on explicit calls, bound subprocesses and sanitize failures", async (t) => {
  const { runOpenSsh } = await import("../../server/features/ssh/ssh-keys.js");
  let scans = 0;
  let connections = 0;
  let fail = false;
  let scannedKey;
  const run = async (command, args, options) => {
    assert.ok(options.timeout > 0 && options.timeout <= 15000);
    assert.ok(options.maxBuffer <= 65536);
    if (command === "ssh-keygen") return runOpenSsh(command, args, options);
    if (command === "ssh-keyscan") {
      scans++;
      assert.equal(args.at(-1), "example.test");
      if (fail) throw new Error("SECRET STDERR");
      return {
        stdout: `# banner\nexample.test ssh-ed25519 AAAA\nexample.test ${scannedKey}\n`,
        stderr: "",
      };
    }
    assert.equal(command, "ssh");
    connections++;
    assert.deepEqual(args.slice(-2), ["example.test", "true"]);
    if (fail) throw new Error("SECRET STDERR");
    return { stdout: "", stderr: "" };
  };
  const { store, input } = fixture(t, { run });
  scannedKey = input.hostKey;
  const access = await store.create(input);
  assert.equal(scans, 0);
  assert.equal(connections, 0);
  const scanned = await store.scan({ host: input.host, port: input.port });
  assert.equal(scanned.hostKey.split(" ")[1], scannedKey.split(" ")[1]);
  assert.equal(scanned.hostFingerprint, access.hostFingerprint);
  assert.deepEqual(await store.test(access.id), { ok: true });
  fail = true;
  for (const operation of [
    () => store.scan({ host: input.host, port: input.port }),
    () => store.test(access.id),
  ])
    await assert.rejects(
      operation(),
      (error) => error.status === 502 && !error.message.includes("SECRET"),
    );
  assert.equal(scans, 2);
  assert.equal(connections, 2);
});

test("rejects a forged key payload with a supported algorithm name", async (t) => {
  const { store, input } = fixture(t);
  const bytes = Buffer.alloc(20);
  bytes.writeUInt32BE(11);
  bytes.write("ssh-ed25519", 4);
  bytes.writeUInt32BE(32, 15);
  await assert.rejects(
    store.create({ ...input, hostKey: `ssh-ed25519 ${bytes.toString("base64")}` }),
    { status: 400 },
  );
});

test("rejects unknown fields and malformed bodies instead of ignoring SSH credentials or options", async (t) => {
  const { endpoint } = await import("../../server/features/ssh/ssh-keys.js");
  const { store, input } = fixture(t);
  const access = await store.create(input);
  for (const unknown of [
    "passphrase",
    "password",
    "options",
    "proxyCommand",
    "key",
    "generateKey",
  ]) {
    await assert.rejects(store.create({ ...input, [unknown]: "secret" }), {
      status: 400,
    });
    await assert.rejects(store.update(access.id, { [unknown]: "secret" }), {
      status: 400,
    });
    await assert.rejects(store.scan({ host: input.host, [unknown]: "secret" }), {
      status: 400,
    });
  }
  for (const body of [null, [], "host", 22, true]) {
    await assert.rejects(store.create(body), { status: 400 });
    await assert.rejects(store.update(access.id, body), { status: 400 });
    await assert.rejects(store.scan(body), { status: 400 });
    assert.throws(() => endpoint(body), { status: 400 });
  }
  assert.deepEqual(store.list(), [access]);
});

test("relative managed files avoid OpenSSH expansion in runtime paths", async (t) => {
  const { dataDir, input } = fixture(t);
  for (const name of [
    "space directory",
    "token%z",
    "token${HOME}",
    "quote'path",
    'quote"path',
    "back\\slash",
  ]) {
    const store = new SshAccessStore({ dataDir: path.join(dataDir, name) });
    const access = await store.create(input);
    const { command, args, cwd } = store.connection(access.id);
    assert.equal(cwd, path.join(dataDir, name, "ssh", "keys", access.id));
    const config = execFileSync(command, ["-G", "-T", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.deepEqual(
      config.split("\n").filter((line) => line.startsWith("identityfile ")),
      ["identityfile identity"],
    );
    assert.deepEqual(
      config.split("\n").filter((line) => line.startsWith("userknownhostsfile ")),
      ["userknownhostsfile known_hosts"],
    );
    assert.match(
      fs.readFileSync(path.join(cwd, "identity"), "utf8"),
      /BEGIN OPENSSH PRIVATE KEY/,
    );
    assert.match(
      fs.readFileSync(path.join(cwd, "known_hosts"), "utf8"),
      /^\[example.test\]:2222 ssh-ed25519 /,
    );
  }
});

test("remote commands cannot be interpreted as local OpenSSH options", async (t) => {
  const { store, input } = fixture(t);
  const access = await store.create(input);
  const { command, args, cwd } = store.connection(access.id);
  assert.deepEqual(args.slice(-2), ["--", "example.test"]);
  const config = execFileSync(
    command,
    ["-G", "-T", ...args, "-o", "ProxyCommand=BADCOMMAND"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.ok(!config.includes("BADCOMMAND"));
});

test("concurrent rename and endpoint edits do not restore stale connection settings", async (t) => {
  const { runOpenSsh } = await import("../../server/features/ssh/ssh-keys.js");
  let hold = false;
  let held = false;
  let release;
  let started;
  let fingerprintResult;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const run = async (command, args, options) => {
    if (hold && args.includes("-l")) {
      if (!held) {
        held = true;
        started();
        await paused;
      }
      return fingerprintResult;
    }
    const result = await runOpenSsh(command, args, options);
    if (args.includes("-l")) fingerprintResult = result;
    return result;
  };
  const { store, input } = fixture(t, { run });
  const access = await store.create(input);
  hold = true;
  const rename = store.update(access.id, { name: "Renamed" });
  await entered;
  const changeHost = store.update(access.id, {
    host: "other.test",
    hostKey: input.hostKey,
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([rename, changeHost]);
  assert.equal(store.get(access.id).host, "other.test");
  assert.equal(store.get(access.id).name, "Renamed");
});
