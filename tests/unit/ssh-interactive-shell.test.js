import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import { runOpenSsh } from "../../server/features/ssh/ssh-keys.js";
import { connectionRevision } from "../../server/features/ssh/sftp-host-access.js";
import { runInteractiveSsh } from "../../server/features/ssh/ssh-interactive-run.js";
import { interactiveShellArgs } from "../../server/features/ssh/ssh-interactive-shell.js";

const device = fileURLToPath(
  new URL("../fixtures/fake-network-device.mjs", import.meta.url),
);

function fixture(t, { exit = 0, flags = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-console-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const hostFile = path.join(dataDir, "host");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostFile]);
  const calls = [],
    consoles = [],
    state = { exit, flags };
  const run = (command, args, options) => {
    if (command !== "ssh") return runOpenSsh(command, args, options);
    calls.push(args);
    if (state.exit === 0) return Promise.resolve({ stdout: "", stderr: "" });
    return Promise.reject(Object.assign(new Error("SECRET"), { code: state.exit }));
  };
  // The fake device replaces OpenSSH; the store's connection shape stays the same.
  const runConsole = (connection, command, options) => {
    consoles.push({ connection, command });
    return runInteractiveSsh(
      { ...connection, command: process.execPath, args: [device, ...state.flags] },
      command,
      { ...options, timing: { idleMs: 300, settleMs: 50 } },
    );
  };
  return {
    dataDir,
    state,
    calls,
    consoles,
    store: new SshAccessStore({ dataDir, run, runConsole }),
    input: {
      name: "Core switch",
      host: "switch.example.test",
      port: 22,
      username: "admin",
      hostKey: fs.readFileSync(`${hostFile}.pub`, "utf8").trim(),
    },
  };
}
const argsOf = (store, id) => {
  const connection = store.connection(id);
  connection.cleanup();
  return connection;
};

test("the switch is off by default and adds -tt only for an opted-in SSH host", async (t) => {
  assert.deepEqual(interactiveShellArgs({ interactiveShell: true }), ["-tt"]);
  assert.deepEqual(interactiveShellArgs({ interactiveShell: "true" }), []);
  assert.deepEqual(interactiveShellArgs({ type: "sftp", interactiveShell: true }), []);
  const { store, input, dataDir } = fixture(t);
  const plain = await store.create(input);
  assert.equal(plain.interactiveShell, false);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "ssh/accesses.json")))[0];
  assert.equal(Object.hasOwn(stored, "interactiveShell"), false);
  const { host, port, username, keyId, hostKey } = stored;
  assert.equal(
    store.revision(plain.id),
    connectionRevision({ host, port, username, keyId, hostKey }),
  );
  const off = argsOf(store, plain.id);
  assert.equal(off.interactive, undefined);
  assert.equal(off.args.includes("-tt"), false);

  const opted = await store.create({
    ...input,
    name: "Old",
    interactiveShell: true,
    legacyAlgorithms: true,
  });
  assert.equal(opted.interactiveShell, true);
  const on = argsOf(store, opted.id);
  assert.equal(on.interactive, true);
  assert.equal(on.args.filter((arg) => arg === "-tt").length, 1);
  assert.ok(on.args.indexOf("-tt") < on.args.indexOf("--"));
  // Hardened options and the legacy switch stay as they are.
  for (const option of [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "PubkeyAcceptedAlgorithms=+ssh-rsa",
  ])
    assert.ok(on.args.includes(option), option);
  assert.equal(on.args.at(-1), "switch.example.test");
});

test("editing the switch changes the revision; other edits keep it", async (t) => {
  const { store, input } = fixture(t);
  const access = await store.create(input);
  const before = store.revision(access.id);
  const on = await store.update(access.id, { interactiveShell: true });
  assert.equal(on.interactiveShell, true);
  const revision = store.revision(access.id);
  assert.notEqual(revision, before);
  assert.equal(
    (await store.update(access.id, { name: "Renamed" })).interactiveShell,
    true,
  );
  assert.equal(store.revision(access.id), revision);
  assert.equal(
    (await store.update(access.id, { interactiveShell: false })).interactiveShell,
    false,
  );
  assert.equal(store.revision(access.id), before);
  for (const value of ["yes", 1, null])
    await assert.rejects(store.update(access.id, { interactiveShell: value }), {
      status: 400,
    });
  await assert.rejects(
    store.create({
      ...input,
      type: "sftp",
      auth: "password",
      password: "x",
      interactiveShell: true,
    }),
    { status: 400 },
  );
});

test("Test connection fails only on an SSH error (exit 255)", async (t) => {
  const { store, input, calls, state } = fixture(t);
  const access = await store.create(input);
  assert.deepEqual(await store.test(access.id), { ok: true });
  assert.equal(calls.at(-1).at(-1), "true");
  // RouterOS and similar devices do not know `true`: signed in, command refused.
  for (const code of [1, 127]) {
    state.exit = code;
    assert.deepEqual(await store.test(access.id), { ok: true, commandRejected: true });
  }
  state.exit = 255;
  await assert.rejects(
    store.test(access.id),
    (error) => error.status === 502 && !error.message.includes("SECRET"),
  );
  state.exit = "ENOENT";
  await assert.rejects(store.test(access.id), { status: 502 });
});

test("Test connection of an interactive host waits for the prompt and logs out", async (t) => {
  const { store, input, calls, consoles, state } = fixture(t);
  const access = await store.create({ ...input, interactiveShell: true });
  assert.deepEqual(await store.test(access.id), { ok: true, interactive: true });
  assert.equal(calls.length, 0);
  assert.equal(consoles.length, 1);
  assert.equal(consoles[0].command, "");
  assert.ok(consoles[0].connection.args.includes("-tt"));
  state.flags = ["--fail"];
  await assert.rejects(store.test(access.id), { status: 502 });
});
