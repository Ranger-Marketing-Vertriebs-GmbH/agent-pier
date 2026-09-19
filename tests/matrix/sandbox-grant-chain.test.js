import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import { MemoryIntegration } from "../../server/features/memory/memory-integration.js";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import { prepareRequests } from "../../server/features/requests/request-launch.js";
import { addGrant } from "../../server/features/nono/sandbox-grants.js";
import {
  INSTALLATION_GRANTS,
  INSTALLATION_ROOT,
  wrapWithNono,
} from "../../server/features/nono/nono-launch.js";

const SESSION = "grant-chain-session";
const upstream = { access: "allow", path: "/fixture/upstream" };
const pairs = (args) =>
  args.reduce(
    (list, value, index) => (index % 2 ? [...list, [args[index - 1], value]] : list),
    [],
  );

// Key order is not behaviour: an inherited grant makes sandboxGrants appear earlier
// in the object than one an adapter introduces, so compare structurally.
const withoutGrants = ({ sandboxGrants: _grants, ...launch }) => launch;

// A grant covers a path when it names it or one of its ancestors. Adapters
// declare directories, the subprocesses reach single files below them.
const covers = (grants, target) =>
  grants.some(
    (grant) => grant.path === target || target.startsWith(grant.path + path.sep),
  );

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-grant-chain-")),
  );
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const dataDir = path.join(root, "data");
  const accounts = new AccountStore({ dataDir, home });
  const memory = new MemoryIntegration({ dataDir, accounts });
  const agentbus = new AgentBus({
    dataDir,
    home,
    accounts,
    sessions: { list: async () => [] },
  });
  t.after(async () => {
    await memory.close();
    await agentbus.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, cwd, accounts, memory, agentbus };
}

/**
 * Runs the real agentbus -> memory links of the launch chain, in that order. Both
 * adapters are deterministic for a fixed data directory and session id: the tokens
 * they mint go to disk, never into the launch, so two runs are comparable.
 */
async function chain({ agentbus, memory, cwd }, account, launch) {
  const afterBus = await agentbus.prepare({
    id: SESSION,
    account,
    cwd,
    launch,
    replace: true,
  });
  return memory.prepare({ id: SESSION, account, cwd, launch: afterBus });
}

test("an upstream grant survives every adapter hop", async (t) => {
  const context = fixture(t);
  const account = context.accounts.get("local-codex");
  const original = context.accounts.command(
    account.id,
    { codex: path.join(context.root, "inert-cli") },
    false,
    "default",
  );
  const granted = await chain(
    context,
    account,
    addGrant(structuredClone(original), upstream),
  );
  // agentbus and memory both rebuild the launch; neither may drop what came before.
  assert.deepEqual(granted.sandboxGrants[0], upstream);
  // Each adapter still declared its own grants on top of the inherited one.
  assert.ok(granted.sandboxGrants.length > 1);
  const root = context.memory.memory.root;
  assert.equal(
    granted.sandboxGrants.some(
      (item) => item.path === path.join(root, "sessions", SESSION),
    ),
    true,
  );
  // The memory MCP server reaches the store over the broker socket, so nothing
  // above its own capability folder is granted: neither the shared database nor
  // another session's capability is reachable from inside the sandbox.
  for (const denied of [
    root,
    path.join(root, "memory.sqlite"),
    path.join(root, "sessions", "other-session"),
  ])
    assert.equal(
      covers(granted.sandboxGrants, denied),
      false,
      `expected no grant covering ${denied}`,
    );
  // No individual adapter declares the whole AgentPier data directory. This is
  // true but not sufficient on its own: see the composed-launch test below for
  // the check that catches a grant becoming that broad transitively, through
  // the nono adapter's own installation grant.
  assert.equal(
    granted.sandboxGrants.some((item) => item.path === context.memory.dataDir),
    false,
  );
});

test("the composed nono launch never exposes the default data directory through the installation grant", async (t) => {
  const context = fixture(t);
  const account = context.accounts.get("local-codex");
  const original = context.accounts.command(
    account.id,
    { codex: path.join(context.root, "inert-cli") },
    false,
    "default",
  );
  const granted = await chain(context, account, original);
  const wrapped = wrapWithNono({
    launch: granted,
    executable: "/opt/homebrew/bin/nono",
    profile: "codex-default",
  });
  const separator = wrapped.args.indexOf("--");
  const grantedPaths = pairs(wrapped.args.slice(4, separator)).map(([, p]) => p);
  // The installation grants must actually be present, or the ancestry check
  // below would pass vacuously on a build that grants nothing at all.
  for (const subtree of INSTALLATION_GRANTS)
    assert.ok(
      grantedPaths.includes(subtree),
      `expected ${subtree} among the composed grants`,
    );
  // A checkout's default data directory, `<installation root>/.data`, is not
  // covered by any single adapter's own grant. The regression this guards
  // against is the nono adapter's installation grant reaching it transitively:
  // before the fix, that grant was the whole installation root, which is the
  // parent of this exact path.
  const defaultDataDir = path.join(INSTALLATION_ROOT, ".data");
  for (const grantedPath of grantedPaths)
    assert.equal(
      grantedPath === defaultDataDir || defaultDataDir.startsWith(grantedPath + path.sep),
      false,
      `${grantedPath} must not cover the default data directory`,
    );
});

test("declaring grants leaves command, args and env untouched", async (t) => {
  const context = fixture(t);
  const account = context.accounts.get("local-codex");
  const original = context.accounts.command(
    account.id,
    { codex: path.join(context.root, "inert-cli") },
    false,
    "default",
  );
  const before = structuredClone(original);
  const withGrants = await chain(
    context,
    account,
    addGrant(structuredClone(original), upstream),
  );
  // Re-run the identical chain from a launch carrying no grants at all. Same data
  // directory and session id, so every path the adapters derive is the same.
  context.memory.discard(SESSION);
  const without = await chain(context, account, structuredClone(original));

  assert.equal(withGrants.command, without.command);
  assert.deepEqual(withGrants.args, without.args);
  assert.deepEqual(withGrants.env, without.env);
  // The launch the adapters were handed was never mutated in place.
  assert.deepEqual(original, before);
  assert.equal(without.command, before.command);
  assert.deepEqual(without.args.slice(0, before.args.length), before.args);
  for (const [name, value] of Object.entries(before.env))
    assert.equal(without.env[name], value);
  // Grants are the only difference between the two runs: everything the session
  // manager consumes is equal once sandboxGrants is set aside.
  assert.equal(
    without.sandboxGrants.some((item) => item.path === upstream.path),
    false,
  );
  assert.deepEqual(withoutGrants(withGrants), withoutGrants(without));
});

test("a managed account grants its own profile directory, not the whole data directory", async (t) => {
  const context = fixture(t);
  const account = context.accounts.create({ name: "Grant chain managed", tool: "codex" });
  const profileRoot = context.accounts.profile(account.id);
  const original = context.accounts.command(
    account.id,
    { codex: path.join(context.root, "inert-cli") },
    false,
    "default",
  );
  // The account-store adapter is first in the chain, so this is the only grant
  // present before agentbus and memory add their own.
  assert.deepEqual(original.sandboxGrants, [{ access: "allow", path: profileRoot }]);
  const granted = await chain(context, account, original);
  assert.equal(
    granted.sandboxGrants.some(
      (item) => item.access === "allow" && item.path === profileRoot,
    ),
    true,
  );
  assert.equal(
    granted.sandboxGrants.some((item) => item.path === context.memory.dataDir),
    false,
  );
});

test("a local account declares no managed-profile grant", (t) => {
  const context = fixture(t);
  const account = context.accounts.get("local-codex");
  const original = context.accounts.command(
    account.id,
    { codex: path.join(context.root, "inert-cli") },
    false,
    "default",
  );
  assert.equal(original.sandboxGrants, undefined);
});

test("the SSH tools grant every path their MCP server reads at startup", async (t) => {
  const context = fixture(t);
  const dataDir = path.join(context.root, "data");
  const account = context.accounts.get("local-codex");
  const integration = new SshIntegration({ dataDir, accounts: context.accounts });
  const granted = await integration.prepare({
    id: SESSION,
    account,
    cwd: context.cwd,
    launch: { command: path.join(context.root, "inert-cli"), args: [], env: {} },
  });
  // The server builds its access store and its grant directory before it answers
  // anything, and authorizes every call against the session record.
  for (const required of [
    path.join(dataDir, "ssh"),
    path.join(dataDir, "ssh", "grants"),
    path.join(dataDir, "ssh", "identities"),
    path.join(dataDir, "sessions", `${SESSION}.json`),
  ])
    assert.ok(
      covers(granted.sandboxGrants, required),
      `expected a grant covering ${required}`,
    );
  // Reaching those paths must not widen into the data directory as a whole.
  assert.equal(covers(granted.sandboxGrants, path.join(dataDir, "memory")), false);
});

test("the Codex request wrapper keeps the executable it replaces granted", async (t) => {
  const context = fixture(t);
  const directory = path.join(context.root, "requests");
  fs.mkdirSync(directory, { recursive: true });
  const broker = {
    directory,
    socketPath: path.join(directory, "broker.sock"),
    file: (id) => path.join(directory, `${id}.json`),
  };
  const command = path.join(context.root, "inert-cli");
  const granted = await prepareRequests(broker, {
    id: SESSION,
    account: { id: "local-codex", tool: "codex" },
    cwd: context.cwd,
    launch: { command, args: [], env: {} },
  });
  // The wrapper takes the launch command over, so nothing downstream can still
  // see the Codex executable that codex-launch.js starts from the request file.
  assert.notEqual(granted.command, command);
  assert.ok(covers(granted.sandboxGrants, command));
});

test("a CLI AgentPier installed grants its package directory, not only its script", (t) => {
  const context = fixture(t);
  const dataDir = path.join(context.root, "data");
  const clis = path.join(dataDir, "clis");
  const version = path.join(clis, ".packages", "installed");
  fs.mkdirSync(path.join(version, "bin"), { recursive: true });
  fs.mkdirSync(path.join(version, "lib", "node_modules", "codex"), { recursive: true });
  fs.writeFileSync(path.join(version, "bin", "codex"), "#!/usr/bin/env node\n");
  // The installer publishes the version directory and activates it through this
  // relative symlink, which is what the launch PATH resolves through.
  fs.symlinkSync(path.join(".packages", "installed"), path.join(clis, "codex"), "dir");
  const launch = context.accounts.command(
    "local-codex",
    { codex: path.join(clis, "codex", "bin", "codex") },
    false,
    "default",
  );
  // A script grant alone leaves every import of the CLI denied, so the grant is
  // the installed version directory, with the activation symlink resolved.
  assert.deepEqual(launch.sandboxGrants, [
    { access: "read", path: fs.realpathSync(path.join(clis, "codex")) },
  ]);
  assert.ok(
    covers(launch.sandboxGrants, path.join(version, "lib", "node_modules", "codex")),
  );
});

test("a CLI installed outside AgentPier declares no installation grant", (t) => {
  const context = fixture(t);
  const command = path.join(context.root, "inert-cli");
  fs.writeFileSync(command, "#!/bin/sh\n");
  assert.equal(
    context.accounts.command("local-codex", { codex: command }, false, "default")
      .sandboxGrants,
    undefined,
  );
});
