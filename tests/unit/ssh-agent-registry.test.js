import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SshAgentRegistry } from "../../server/features/ssh/ssh-agent-registry.js";
import { agentHosts } from "../../server/features/ssh/ssh-agent-policy.js";
import {
  agentSocketLocation,
  newAgentToken,
} from "../../server/features/ssh/ssh-agent-socket.js";
import { SessionSshAgents } from "../../server/features/ssh/ssh-session-agents.js";
import { ownerFolder } from "../../server/features/ssh/ssh-session-config.js";
import {
  fixture,
  home,
  hostA as accessA,
  identitiesAt,
  launch,
  root,
} from "../helpers/ssh-session-agents-fixture.js";

const [hostA] = agentHosts([accessA], [accessA.id]);
const session = { kind: "session", id: "s1" };
const agent = { kind: "agent", id: "main" };
const binaries = { ssh: "/usr/bin/ssh" };

let counter = 0;
// One registry per test with its own data dir, a recorded ~/.ssh/config dispatcher,
// audit and log; the stand-in home lives under /tmp.
function registryFixture(t, options = {}) {
  counter += 1;
  const dataDir = path.join(root, `registry-${counter}`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const userConfig = {
    updates: [],
    update(entries) {
      this.updates.push(entries);
    },
    problemFor: () => null,
  };
  const audit = [];
  const logs = [];
  const registry = new SshAgentRegistry({
    dataDir,
    audit: { append: (row) => audit.push(row) },
    openssh: { major: 10, minor: 2 },
    home,
    log: {
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    userConfig,
    ...options,
  });
  t.after(async () => {
    await registry.close();
    await registry.teardown(session);
    await registry.teardown(agent);
  });
  return { dataDir, registry, userConfig, audit, logs };
}

const grant = (hosts) => async () => ({ hosts });

test("one dispatcher lists sessions and agents with their own configs", async (t) => {
  const { dataDir, registry, userConfig } = registryFixture(t);
  const tokenA = newAgentToken();
  const tokenB = newAgentToken();
  await registry.start(session, { token: tokenA, binaries, authorize: grant([hostA]) });
  await registry.start(agent, { token: tokenB, binaries, authorize: grant([hostA]) });
  assert.equal(await registry.write(session, [hostA]), "written");
  assert.equal(
    await registry.write(agent, [hostA], { shellEnv: "export A=1\n" }),
    "written",
  );
  assert.equal(
    await registry.write(agent, [hostA], { shellEnv: "export A=1\n" }),
    "unchanged",
  );
  assert.equal(
    await registry.write(agent, [hostA], { shellEnv: "export A=2\n" }),
    "written",
  );
  const entries = userConfig.updates.at(-1);
  assert.deepEqual(
    entries.map((e) => e.configPath).sort(),
    [
      path.join(ownerFolder(dataDir, agent), "ssh_config"),
      path.join(ownerFolder(dataDir, session), "ssh_config"),
    ].sort(),
  );
  assert.deepEqual(
    entries.map((e) => e.aliases),
    [["proxmox-2"], ["proxmox-2"]],
  );
  assert.deepEqual(registry.aliases(agent), { [hostA.accessId]: "proxmox-2" });
  assert.equal(
    fs.readFileSync(path.join(ownerFolder(dataDir, agent), "shell-env.sh"), "utf8"),
    "export A=2\n",
  );
  assert.equal(
    fs.existsSync(path.join(ownerFolder(dataDir, session), "shell-env.sh")),
    false,
  );
  assert.deepEqual(
    registry.entries("agent").map((entry) => entry.id),
    [agent.id],
  );
  assert.equal(registry.entries().length, 2);
  assert.equal(registry.userConfigProblem(agent), null);
});

test("change listeners hear only their kind", async (t) => {
  const { registry } = registryFixture(t);
  await registry.start(session, {
    token: newAgentToken(),
    binaries,
    authorize: grant([]),
  });
  await registry.start(agent, { token: newAgentToken(), binaries, authorize: grant([]) });
  const heard = [];
  const sessions = [];
  registry.listen("agent", (id) => heard.push(id));
  const stop = registry.listen("session", (id) => sessions.push(id));
  registry.listen("agent", () => {
    throw new Error("ignored");
  });
  await registry.write(session, [hostA]);
  await registry.write(agent, [hostA]);
  stop();
  await registry.write(session, []);
  assert.deepEqual(heard, [agent.id]);
  assert.deepEqual(sessions, [session.id]);
});

test("a token in use by another owner is reported, also from stored session records", async (t) => {
  const { registry } = registryFixture(t);
  const tokenA = newAgentToken();
  const stored = newAgentToken();
  await registry.start(session, { token: tokenA, binaries, authorize: grant([]) });
  assert.equal(registry.tokenInUse(tokenA, agent), true);
  assert.equal(registry.tokenInUse(tokenA, session), false);
  assert.equal(registry.tokenInUse(stored, agent), false);
  // A session record names a token although its agent is not listening (yet).
  registry.tokenSource("session", () => [{ id: "s2", token: stored }]);
  assert.equal(registry.tokenInUse(stored, agent), true);
  assert.equal(registry.tokenInUse(stored, { kind: "session", id: "s2" }), false);
  registry.tokenSource("agent", () => {
    throw new Error("unreadable");
  });
  assert.equal(registry.tokenInUse(newAgentToken(), agent), false);
});

test("a failed write leaves pass-through wrappers and no aliases, then retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dataDir, registry, logs } = registryFixture(t, { retryDelays: [1000] });
  let resyncCalls = 0;
  const changed = [];
  registry.listen("agent", (id) => changed.push(id));
  await registry.start(agent, {
    token: newAgentToken(),
    binaries,
    authorize: grant([hostA]),
    resync: async () => {
      resyncCalls += 1;
    },
  });
  const folder = ownerFolder(dataDir, agent);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, "keys"), "planted");
  await assert.rejects(registry.write(agent, [hostA]), { code: "SSH_FOLDER_UNSAFE" });
  assert.deepEqual(registry.aliases(agent), {});
  assert.ok(fs.existsSync(path.join(folder, "bin", "ssh")));
  assert.deepEqual(changed, [agent.id]);
  assert.deepEqual(logs, [
    ["error", "Agent SSH agent files could not be written:", "SSH_FOLDER_UNSAFE"],
  ]);
  assert.equal(resyncCalls, 0);
  t.mock.timers.tick(1000);
  assert.equal(resyncCalls, 1);
  // A host list that cannot be read fails the same way, without a second retry
  // once the delays are used up.
  await assert.rejects(
    registry.write(agent, async () => {
      throw Object.assign(new Error("catalog"), { code: "SSH_CATALOG_UNAVAILABLE" });
    }),
    { code: "SSH_CATALOG_UNAVAILABLE" },
  );
  t.mock.timers.tick(30000);
  assert.equal(resyncCalls, 1);
});

test("a replaced or closed entry refuses every signature", async (t) => {
  const { registry } = registryFixture(t);
  const first = await registry.start(agent, {
    token: newAgentToken(),
    binaries,
    authorize: grant([hostA]),
  });
  assert.equal((await first.socket.authorize()).hosts.length, 1);
  const second = await registry.start(agent, {
    token: first.token,
    binaries,
    authorize: grant([hostA]),
  });
  assert.notEqual(first, second);
  assert.equal(registry.get(agent), second);
  assert.equal(await first.socket.authorize(), null);
  assert.equal((await second.socket.authorize()).hosts.length, 1);
  assert.equal((await identitiesAt(second.location.socketPath)).length, 1);
  const denied = await registry.start(session, {
    token: newAgentToken(),
    binaries,
    authorize: async () => null,
  });
  assert.equal(await denied.socket.authorize(), null);
});

test("close(kind) closes only that kind's sockets and keeps the folders", async (t) => {
  const { dataDir, registry } = registryFixture(t);
  const s = await registry.start(session, {
    token: newAgentToken(),
    binaries,
    authorize: grant([hostA]),
  });
  const a = await registry.start(agent, {
    token: newAgentToken(),
    binaries,
    authorize: grant([hostA]),
  });
  await registry.write(session, [hostA]);
  await registry.write(agent, [hostA]);
  await registry.close("session");
  assert.equal(registry.get(session), undefined);
  assert.equal(registry.get(agent), a);
  await assert.rejects(identitiesAt(s.location.socketPath));
  assert.equal((await identitiesAt(a.location.socketPath)).length, 1);
  assert.ok(fs.existsSync(ownerFolder(dataDir, session)));
  await registry.close();
  assert.deepEqual(registry.entries(), []);
  assert.ok(fs.existsSync(ownerFolder(dataDir, agent)));
});

test("teardown removes the owner's folder and token folder only", async (t) => {
  const { dataDir, registry } = registryFixture(t);
  const s = await registry.start(session, {
    token: newAgentToken(),
    binaries,
    authorize: grant([]),
  });
  const a = await registry.start(agent, {
    token: newAgentToken(),
    binaries,
    authorize: grant([]),
  });
  await registry.write(session, [hostA]);
  await registry.write(agent, [hostA]);
  await registry.teardown(agent);
  assert.equal(registry.get(agent), undefined);
  assert.equal(fs.existsSync(ownerFolder(dataDir, agent)), false);
  assert.equal(fs.existsSync(path.dirname(a.location.socketPath)), false);
  assert.equal(fs.existsSync(ownerFolder(dataDir, session)), true);
  assert.equal(fs.existsSync(path.dirname(s.location.socketPath)), true);
});

test("teardown never removes a token folder another live owner uses", async (t) => {
  const { dataDir, registry } = registryFixture(t);
  const s = await registry.start(session, {
    token: newAgentToken(),
    binaries,
    authorize: grant([]),
  });
  // An agent whose stored token collides with the live session's is torn down by token.
  await registry.teardown(agent, s.token);
  assert.equal(fs.existsSync(s.location.socketPath), true);
  // A token only a session record names is kept, too.
  const stored = newAgentToken();
  const { socketPath } = agentSocketLocation(dataDir, agent.id, stored, { home });
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  registry.tokenSource("session", () => [{ id: "s2", token: stored }]);
  await registry.teardown(agent, stored);
  assert.equal(fs.existsSync(path.dirname(socketPath)), true);
  fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("sessions share a registry handed to them and register their stored tokens", async (t) => {
  const f = fixture(t);
  const registry = new SshAgentRegistry({
    dataDir: f.dataDir,
    audit: { append: (row) => f.audit.push(row) },
    openssh: { major: 10, minor: 2 },
    home,
    log: f.log,
  });
  const agents = new SessionSshAgents({ ...f.deps, registry });
  f.agents = agents;
  f.started.push(agents);
  t.after(() => registry.close());
  const { id, record } = await launch(f);
  assert.equal(agents.registry, registry);
  assert.deepEqual(
    registry.entries("session").map((entry) => entry.id),
    [id],
  );
  assert.equal(registry.tokenInUse(record.sshAgent.token, agent), true);
  // Without a live listener the stored record still names the token (A2).
  await agents.close();
  assert.equal(registry.entries("session").length, 0);
  assert.equal(registry.tokenInUse(record.sshAgent.token, agent), true);
  const heard = [];
  registry.listen("session", (other) => heard.push(other));
  agents.onChange = (other) => heard.push(`own:${other}`);
  await agents.discard(id);
  // The adapter's own listener came first; the service's hears the same once.
  assert.deepEqual(heard, [`own:${id}`, id]);
});

test("a start with a token another owner listens with or keeps is refused", async (t) => {
  const { registry } = registryFixture(t);
  const live = await registry.start(session, {
    token: newAgentToken(),
    binaries,
    authorize: grant([]),
  });
  await assert.rejects(
    registry.start(agent, { token: live.token, binaries, authorize: grant([]) }),
    { code: "SSH_AGENT_TOKEN_IN_USE" },
  );
  const stored = newAgentToken();
  registry.tokenSource("session", () => [{ id: "s2", token: stored }]);
  await assert.rejects(
    registry.start(agent, { token: stored, binaries, authorize: grant([]) }),
    { code: "SSH_AGENT_TOKEN_IN_USE" },
  );
  assert.equal(registry.get(agent), undefined);
  // The owner keeping the token may listen with it.
  const restored = await registry.start(
    { kind: "session", id: "s2" },
    { token: stored, binaries, authorize: grant([]) },
  );
  t.after(() => registry.teardown({ kind: "session", id: "s2" }));
  assert.equal(restored.token, stored);
});

test("an entry replaced while authorize answers refuses the signature", async (t) => {
  const { registry } = registryFixture(t);
  const entry = await registry.start(agent, {
    token: newAgentToken(),
    binaries,
    authorize: async () => {
      await registry.teardown(agent);
      return { hosts: [hostA], projectId: "p1" };
    },
  });
  assert.equal(await entry.socket.authorize(), null);
  assert.equal(entry.projectId, undefined);
});

test("a write whose entry is torn down while the hosts are read writes nothing", async (t) => {
  const { dataDir, registry } = registryFixture(t);
  const changed = [];
  registry.listen("agent", (id) => changed.push(id));
  await registry.start(agent, { token: newAgentToken(), binaries, authorize: grant([]) });
  const result = await registry.write(agent, async () => {
    await registry.teardown(agent);
    return [hostA];
  });
  assert.equal(result, "unchanged");
  assert.equal(fs.existsSync(ownerFolder(dataDir, agent)), false);
  assert.deepEqual(changed, []);
  // A failing host read of a torn-down entry rethrows without re-creating the folder.
  await registry.start(agent, { token: newAgentToken(), binaries, authorize: grant([]) });
  await assert.rejects(
    registry.write(agent, async () => {
      await registry.teardown(agent);
      throw Object.assign(new Error("catalog"), { code: "SSH_CATALOG_UNAVAILABLE" });
    }),
    { code: "SSH_CATALOG_UNAVAILABLE" },
  );
  assert.equal(fs.existsSync(ownerFolder(dataDir, agent)), false);
  assert.deepEqual(changed, []);
});

test("close goes on past a socket that fails to close", async (t) => {
  const { registry, logs } = registryFixture(t);
  const s = await registry.start(session, {
    token: newAgentToken(),
    binaries,
    authorize: grant([]),
  });
  await registry.start(agent, { token: newAgentToken(), binaries, authorize: grant([]) });
  const close = s.socket.close.bind(s.socket);
  s.socket.close = async () => {
    await close();
    throw Object.assign(new Error("close"), { code: "EBUSY" });
  };
  await registry.close();
  assert.deepEqual(registry.entries(), []);
  assert.deepEqual(logs, [["error", "Session SSH agent could not be closed:", "EBUSY"]]);
});
