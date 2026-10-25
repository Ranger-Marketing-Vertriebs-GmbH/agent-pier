import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import { runOpenSsh } from "../../server/features/ssh/ssh-keys.js";
import { connectionRevision } from "../../server/features/ssh/sftp-host-access.js";
import {
  legacyOptionArgs,
  legacyOptions,
} from "../../server/features/ssh/ssh-legacy-algorithms.js";

const legacyArgs = ["PubkeyAcceptedAlgorithms=+ssh-rsa", "HostKeyAlgorithms=+ssh-rsa"];

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-legacy-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const hostFile = path.join(dataDir, "host");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostFile]);
  const calls = [];
  const run = (command, args, options) => {
    if (command === "ssh") {
      calls.push(args);
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    return runOpenSsh(command, args, options);
  };
  return {
    dataDir,
    calls,
    store: new SshAccessStore({ dataDir, run }),
    input: {
      name: "Old switch",
      host: "switch.example.test",
      port: 22,
      username: "admin",
      hostKey: fs.readFileSync(`${hostFile}.pub`, "utf8").trim(),
    },
  };
}
const count = (args, option) => args.filter((arg) => arg === option).length;
const argsOf = (store, id) => {
  const connection = store.connection(id);
  connection.cleanup();
  return connection.args;
};

test("the argument builder adds both ssh-rsa options only for an opted-in SSH host", () => {
  assert.deepEqual(legacyOptions, legacyArgs);
  assert.deepEqual(legacyOptionArgs({ type: "ssh" }), []);
  assert.deepEqual(legacyOptionArgs({ legacyAlgorithms: false }), []);
  assert.deepEqual(legacyOptionArgs({ legacyAlgorithms: "true" }), []);
  assert.deepEqual(legacyOptionArgs({ type: "sftp", legacyAlgorithms: true }), []);
  assert.deepEqual(legacyOptionArgs({ legacyAlgorithms: true }), [
    "-o",
    legacyArgs[0],
    "-o",
    legacyArgs[1],
  ]);
});

test("hosts are off by default and their connection adds no legacy options", async (t) => {
  const { store, input, dataDir } = fixture(t);
  const access = await store.create(input);
  assert.equal(access.legacyAlgorithms, false);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "ssh/accesses.json")))[0];
  assert.equal(Object.hasOwn(stored, "legacyAlgorithms"), false);
  const args = argsOf(store, access.id);
  for (const option of legacyArgs) assert.equal(args.includes(option), false);
  assert.ok(!args.some((arg) => /ssh-rsa|Algorithms/.test(arg)));
  // Existing hosts keep their connection revision, so receipts stay valid.
  const { host, port, username, keyId, hostKey } = stored;
  assert.equal(
    store.revision(access.id),
    connectionRevision({ host, port, username, keyId, hostKey }),
  );
});

test("an opted-in host adds both options exactly once and only for itself", async (t) => {
  const { store, input, calls } = fixture(t);
  const legacy = await store.create({ ...input, legacyAlgorithms: true });
  const modern = await store.create({ ...input, name: "Modern", host: "new.test" });
  assert.equal(legacy.legacyAlgorithms, true);
  assert.equal(store.get(legacy.id).legacyAlgorithms, true);
  const args = argsOf(store, legacy.id);
  for (const option of legacyArgs) {
    assert.equal(count(args, option), 1, option);
    assert.equal(args[args.indexOf(option) - 1], "-o");
    // Options precede the destination; nothing after `--` is an option.
    assert.ok(args.indexOf(option) < args.indexOf("--"));
  }
  assert.equal(args.at(-1), "switch.example.test");
  for (const option of legacyArgs)
    assert.equal(argsOf(store, modern.id).includes(option), false);
  // Test connection runs the same connection.
  await store.test(legacy.id);
  await store.test(modern.id);
  assert.equal(count(calls[0], legacyArgs[0]), 1);
  assert.equal(count(calls[0], legacyArgs[1]), 1);
  assert.equal(calls[1].includes(legacyArgs[0]), false);
});

test("editing the flag changes the revision and other edits keep it", async (t) => {
  const { store, input, dataDir } = fixture(t);
  const access = await store.create(input);
  const before = store.revision(access.id);
  const enabled = await store.update(access.id, { legacyAlgorithms: true });
  assert.equal(enabled.legacyAlgorithms, true);
  const revision = store.revision(access.id);
  assert.notEqual(revision, before);
  const renamed = await store.update(access.id, { name: "Renamed" });
  assert.equal(renamed.legacyAlgorithms, true);
  assert.equal(store.revision(access.id), revision);
  assert.ok(argsOf(store, access.id).includes(legacyArgs[0]));
  const disabled = await store.update(access.id, { legacyAlgorithms: false });
  assert.equal(disabled.legacyAlgorithms, false);
  assert.equal(store.revision(access.id), before);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "ssh/accesses.json")))[0];
  assert.equal(Object.hasOwn(stored, "legacyAlgorithms"), false);
  assert.equal(argsOf(store, access.id).includes(legacyArgs[0]), false);
});

test("rows from older releases read as off and invalid values are rejected", async (t) => {
  const { store, input, dataDir } = fixture(t);
  const access = await store.create({ ...input, legacyAlgorithms: true });
  const file = path.join(dataDir, "ssh/accesses.json");
  const rows = JSON.parse(fs.readFileSync(file));
  delete rows[0].legacyAlgorithms;
  fs.writeFileSync(file, JSON.stringify(rows));
  assert.equal(new SshAccessStore({ dataDir }).get(access.id).legacyAlgorithms, false);
  assert.equal(argsOf(store, access.id).includes(legacyArgs[0]), false);
  for (const value of ["yes", 1, null])
    await assert.rejects(store.create({ ...input, legacyAlgorithms: value }), {
      status: 400,
    });
  await assert.rejects(store.update(access.id, { legacyAlgorithms: "on" }), {
    status: 400,
  });
  // The built-in SFTP client negotiates ssh-rsa itself; SFTP hosts have no switch.
  await assert.rejects(
    store.create({
      ...input,
      type: "sftp",
      auth: "password",
      password: "x",
      legacyAlgorithms: true,
    }),
    { status: 400 },
  );
});

test("system OpenSSH accepts the options and enables ssh-rsa for the opted-in host", async (t) => {
  const { store, input } = fixture(t);
  const legacy = await store.create({ ...input, legacyAlgorithms: true });
  const modern = await store.create({ ...input, name: "Modern", host: "new.test" });
  const resolved = (id) => {
    const { args, cwd, cleanup } = store.connection(id);
    try {
      const output = execFileSync("ssh", ["-G", ...args], { cwd, encoding: "utf8" });
      return Object.fromEntries(
        output
          .split("\n")
          .filter((line) => /^(pubkeyacceptedalgorithms|hostkeyalgorithms) /.test(line))
          .map((line) => [line.split(" ")[0], line.split(" ")[1].split(",")]),
      );
    } finally {
      cleanup();
    }
  };
  const on = resolved(legacy.id);
  assert.ok(on.pubkeyacceptedalgorithms.includes("ssh-rsa"));
  assert.ok(on.hostkeyalgorithms.includes("ssh-rsa"));
  // Without the switch, modern OpenSSH (8.8+) leaves ssh-rsa out.
  const off = resolved(modern.id);
  const version = spawnSync("ssh", ["-V"], { encoding: "utf8" }).stderr;
  const [major, minor] = (/OpenSSH_(\d+)\.(\d+)/.exec(version) || [])
    .slice(1)
    .map(Number);
  if (major > 8 || (major === 8 && minor >= 8))
    assert.equal(off.pubkeyacceptedalgorithms.includes("ssh-rsa"), false);
});
