import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as store from "../../server/features/clis/claude/login-store.js";
import { installShim } from "../../server/features/accounts/managed-logins.js";

const SERVICE = "Claude Code-credentials-0a1b2c3d";
const login = (expiresAt, token = "token") =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-login-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * The shipped stand-in, installed with a recording fake as the real tool: the fake
 * writes its arguments and standard input to a log and exits with 7.
 */
function shimFixture(t) {
  const root = scratch(t);
  const log = path.join(root, "real.log");
  const real = path.join(root, "real security");
  fs.writeFileSync(
    real,
    `#!/bin/sh\n{ printf 'args:'; printf ' [%s]' "$@"; echo; [ -t 0 ] || sed 's/^/stdin: /'; } >> '${log}'\necho real-output\nexit 7\n`,
    { mode: 0o700 },
  );
  const directory = installShim(path.join(root, "shim"), store.shim, real);
  const run = (args, input) =>
    spawnSync("security", args, {
      env: { PATH: `${directory}:/usr/bin:/bin` },
      encoding: "utf8",
      ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
    });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  return { run, calls, directory };
}

test("the stand-in answers Claude Code's credential lookups as not found", (t) => {
  const { run, calls } = shimFixture(t);
  for (const args of [
    ["find-generic-password", "-a", "me", "-w", "-s", SERVICE],
    ["delete-generic-password", "-a", "me", "-s", SERVICE],
    ["add-generic-password", "-U", "-a", "me", "-s", SERVICE, "-X", "7b7d"],
    // The CLI's default profile uses the name without a suffix.
    ["find-generic-password", "-a", "me", "-w", "-s", "Claude Code-credentials"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 44, args[0]);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /could not be found in the keychain/);
  }
  assert.equal(calls(), "", "the real tool never sees a credential call");
});

test("the stand-in refuses a login stored through standard input", (t) => {
  const { run, calls } = shimFixture(t);
  const result = run(
    ["-i"],
    `add-generic-password -U -a "me" -s "${SERVICE}" -X "7b22613a317d"\n`,
  );
  assert.equal(result.status, 44);
  assert.equal(result.stdout, "");
  assert.equal(calls(), "");
});

test("the stand-in passes every other call to the real tool unchanged", (t) => {
  const { run, calls } = shimFixture(t);
  const plain = run(["find-generic-password", "-s", "Some Service", "-w"]);
  assert.equal(plain.status, 7, "the real tool's exit code comes back");
  assert.equal(plain.stdout, "real-output\n");
  // Claude Code's other items (its API key service) are not credential items.
  run(["find-generic-password", "-a", "me", "-w", "-s", "Claude Code-0a1b2c3d"]);
  const piped = run(["-i"], 'find-generic-password -s "Other"\nlist-keychains\n');
  assert.equal(piped.status, 7);
  assert.equal(piped.stdout, "real-output\n");
  assert.equal(
    calls(),
    [
      "args: [find-generic-password] [-s] [Some Service] [-w]",
      "args: [find-generic-password] [-a] [me] [-w] [-s] [Claude Code-0a1b2c3d]",
      "args: [-i]",
      'stdin: find-generic-password -s "Other"',
      "stdin: list-keychains",
      "",
    ].join("\n"),
  );
});

test("the shipped stand-in names the system keychain tool", () => {
  const text = fs.readFileSync(store.shim.source, "utf8");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.match(text, /^real=\/usr\/bin\/security$/m);
  assert.equal(store.shim.name, "security");
});

test("installing the stand-in is repeatable and leaves an executable file", (t) => {
  const root = scratch(t);
  const directory = path.join(root, "shim");
  installShim(directory, store.shim);
  const file = path.join(directory, "security");
  const first = fs.statSync(file);
  assert.equal(first.mode & 0o777, 0o700);
  assert.match(fs.readFileSync(file, "utf8"), /^real='\/usr\/bin\/security'$/m);
  fs.chmodSync(file, 0o600);
  installShim(directory, store.shim);
  assert.equal(fs.statSync(file).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(file).mtimeMs,
    first.mtimeMs,
    "unchanged text is not rewritten",
  );
});

test("the keychain service name follows Claude Code's own derivation", () => {
  // sha256("/data/profiles/a/claude") starts with these eight hex digits.
  assert.equal(
    store.serviceName("/data/profiles/a/claude"),
    "Claude Code-credentials-684ddaeb",
  );
  // Compared in NFC, as the CLI does.
  assert.equal(store.serviceName("/p/ü"), store.serviceName("/p/ü"));
});

/** A keychain that holds at most one item, with the calls made to it. */
function keychain(value) {
  const state = { value, calls: [], fail: null };
  state.run = async (args) => {
    state.calls.push(args.join(" "));
    if (state.fail) return state.fail(args);
    if (args[0] === "find-generic-password")
      return state.value === undefined
        ? { code: 44, stdout: "" }
        : { code: 0, stdout: `${state.value}\n` };
    if (args[0] === "delete-generic-password") {
      const code = state.value === undefined ? 44 : 0;
      state.value = undefined;
      return { code, stdout: "" };
    }
    throw new Error(`unexpected ${args[0]}`);
  };
  return state;
}
function account(t) {
  const root = scratch(t);
  const file = path.join(root, "claude", ".credentials.json");
  return {
    root,
    file,
    read: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null),
    write: (text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
  };
}
const options = (chain, busy = false) => ({
  run: chain.run,
  user: "me",
  busy: async () => busy,
});

test("an idle account's keychain login moves to the file, then the item goes", async (t) => {
  const a = account(t);
  const chain = keychain(login(100));
  assert.equal(await store.settle(a.root, options(chain)), "file");
  assert.equal(a.read(), login(100));
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  assert.equal(chain.value, undefined);
  assert.equal(store.marked(a.root), true);
  const service = store.serviceName(path.join(a.root, "claude"));
  assert.deepEqual(chain.calls, [
    `find-generic-password -a me -w -s ${service}`,
    `delete-generic-password -a me -s ${service}`,
  ]);
  assert.deepEqual(
    fs.readdirSync(path.dirname(a.file)),
    [".credentials.json"],
    "no temporary file stays behind",
  );
  // Settled accounts are not looked up again.
  assert.equal(await store.settle(a.root, options(chain)), "file");
  assert.equal(chain.calls.length, 2);
});

test("an account without a keychain item starts on the file store", async (t) => {
  const a = account(t);
  assert.equal(await store.settle(a.root, options(keychain())), "file");
  assert.equal(store.marked(a.root), true);
  assert.equal(a.read(), null);
});

test("an account with running sessions keeps the keychain until they end", async (t) => {
  const a = account(t);
  const chain = keychain(login(100));
  assert.equal(await store.settle(a.root, options(chain, true)), "keychain");
  assert.deepEqual(chain.calls, [], "the keychain is not even read");
  assert.equal(store.marked(a.root), false);
  assert.equal(a.read(), null);
  assert.equal(await store.settle(a.root, options(chain, false)), "file");
  assert.equal(a.read(), login(100));
});

test("a keychain that cannot be read changes nothing", async (t) => {
  for (const fail of [
    async () => ({ code: 36, stdout: "" }),
    async () => ({ code: 1, stdout: "" }),
    async () => {
      throw new Error("no keychain here");
    },
    // An item that is no login object is not AgentPier's to move.
    async () => ({ code: 0, stdout: "not json\n" }),
    async () => ({ code: 0, stdout: "[1]\n" }),
  ]) {
    const a = account(t);
    const chain = keychain(login(100));
    chain.fail = fail;
    assert.equal(await store.settle(a.root, options(chain)), "keychain");
    assert.equal(store.marked(a.root), false);
    assert.equal(a.read(), null);
    assert.equal(chain.value, login(100));
  }
});

test("the item stays when the file cannot be written", async (t) => {
  const a = account(t);
  // A file where the config folder belongs: the write fails.
  fs.writeFileSync(path.join(a.root, "claude"), "");
  const chain = keychain(login(100));
  assert.equal(await store.settle(a.root, options(chain)), "keychain");
  assert.equal(chain.value, login(100));
  assert.equal(store.marked(a.root), false);
});

test("an item that cannot be deleted leaves the account on the keychain, and a retry finishes", async (t) => {
  const a = account(t);
  const chain = keychain(login(100));
  const run = chain.run;
  chain.run = async (args) =>
    args[0] === "delete-generic-password" ? { code: 1, stdout: "" } : run(args);
  assert.equal(await store.settle(a.root, options(chain)), "keychain");
  assert.equal(a.read(), login(100), "the copy is already in place");
  assert.equal(chain.value, login(100));
  assert.equal(store.marked(a.root), false);
  chain.run = run;
  assert.equal(await store.settle(a.root, options(chain)), "file");
  assert.equal(chain.value, undefined);
  assert.equal(store.marked(a.root), true);
});

test("with a login in both stores the more recently refreshed one is kept", async (t) => {
  const newerFile = account(t);
  newerFile.write(login(200, "file"));
  let chain = keychain(login(100, "keychain"));
  assert.equal(await store.settle(newerFile.root, options(chain)), "file");
  assert.equal(newerFile.read(), login(200, "file"));
  assert.equal(chain.value, undefined);

  const newerItem = account(t);
  newerItem.write(login(100, "file"));
  chain = keychain(login(200, "keychain"));
  assert.equal(await store.settle(newerItem.root, options(chain)), "file");
  assert.equal(newerItem.read(), login(200, "keychain"));

  // An empty or broken file counts as missing.
  for (const text of ["", "{}", "{broken"]) {
    const a = account(t);
    a.write(text);
    assert.equal(await store.settle(a.root, options(keychain(login(1)))), "file");
    assert.equal(a.read(), login(1));
  }
});

test("a value the keychain tool prints as hex is stored as its text", async (t) => {
  const a = account(t);
  const text = JSON.stringify({ claudeAiOauth: { accessToken: "t" }, name: "Zoë" });
  const chain = keychain(Buffer.from(text, "utf8").toString("hex"));
  assert.equal(await store.settle(a.root, options(chain)), "file");
  assert.equal(a.read(), text);
});

test("a settled account whose login is back in the keychain is healed while idle", async (t) => {
  const a = account(t);
  await store.settle(a.root, options(keychain()));
  assert.equal(store.marked(a.root), true);
  // An older AgentPier ran the account without the stand-in and signed in.
  const chain = keychain(login(300));
  assert.equal(await store.settle(a.root, options(chain)), "file");
  assert.equal(a.read(), login(300));
  assert.equal(chain.value, undefined);
});

test("a settled account whose login is back in the keychain follows its running sessions", async (t) => {
  const a = account(t);
  await store.settle(a.root, options(keychain()));
  const chain = keychain(login(300));
  assert.equal(await store.settle(a.root, options(chain, true)), "keychain");
  assert.equal(store.marked(a.root), false);
  assert.equal(chain.value, login(300));
  assert.equal(a.read(), null);
});

test("a signed-out settled account stays on the file store", async (t) => {
  const a = account(t);
  const chain = keychain();
  await store.settle(a.root, options(chain));
  assert.equal(await store.settle(a.root, options(chain, true)), "file");
  chain.fail = async () => ({ code: 36, stdout: "" });
  assert.equal(await store.settle(a.root, options(chain)), "file");
  assert.equal(store.marked(a.root), true);
});

test("concurrent decisions for one account run one after the other", async (t) => {
  const a = account(t);
  const chain = keychain(login(100));
  const results = await Promise.all([
    store.settle(a.root, options(chain)),
    store.settle(a.root, options(chain)),
    store.settle(a.root, options(chain)),
  ]);
  assert.deepEqual(results, ["file", "file", "file"]);
  assert.equal(chain.calls.length, 2, "one read and one delete in total");
});

test("forgetting an account deletes its keychain item", async (t) => {
  const a = account(t);
  const chain = keychain(login(100));
  assert.equal(await store.forget(a.root, options(chain)), true);
  assert.equal(chain.value, undefined);
  assert.equal(await store.forget(a.root, options(chain)), true, "absent is fine");
});

test("the stand-in's folder comes first on PATH", () => {
  assert.deepEqual(store.environment({ PATH: "/usr/bin:/bin", HOME: "/h" }, "/d/shim"), {
    PATH: "/d/shim:/usr/bin:/bin",
    HOME: "/h",
  });
  assert.equal(store.environment({}, "/d/shim").PATH, "/d/shim");
});

test("a local profile's login is hidden from a sandbox unless it is a file", (t) => {
  const home = scratch(t);
  assert.equal(store.localHidden(home), true);
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), login(1));
  assert.equal(store.localHidden(home), false);
  // A managed account is out of reach until it is on the file store or has a file.
  const root = scratch(t);
  assert.equal(store.managedHidden(root), true);
  fs.mkdirSync(path.join(root, "claude"));
  fs.writeFileSync(path.join(root, "claude", ".credentials.json"), "{}");
  assert.equal(store.managedHidden(root), true);
  fs.writeFileSync(path.join(root, "claude", ".credentials.json"), login(1));
  assert.equal(store.managedHidden(root), false);
  assert.equal(store.supported("darwin"), true);
  assert.equal(store.supported("linux"), false);
});
