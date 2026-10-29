import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agentSocketLocation } from "../../server/features/ssh/ssh-agent-socket.js";
import { SSH_AGENT_HINT_ENV } from "../../server/features/ssh/ssh-hook.js";
import {
  agentEligible,
  SessionSshAgents,
  SSH_AGENT_SOCK_ENV,
  SSH_CONFIG_ENV,
} from "../../server/features/ssh/ssh-session-agents.js";
import { sessionFolder } from "../../server/features/ssh/ssh-session-config.js";
import { AgentClient, userauth } from "../helpers/ssh-agent-client.js";
import {
  base,
  fixture,
  home,
  host,
  hostA,
  hostB,
  hostKey,
  identitiesAt,
  input,
  keyId,
  launch,
  project,
  root,
  userKey,
} from "../helpers/ssh-session-agents-fixture.js";

test("prepare equips each coding CLI with an agent and the data Task 6 needs", async (t) => {
  const f = fixture(t);
  for (const tool of ["claude", "codex", "opencode"]) {
    const { id, prepared } = await launch(f, { tool });
    const { generation, token, enabled } = prepared.sshAgent;
    assert.deepEqual(Object.keys(prepared.sshAgent).sort(), [
      "binaries",
      "enabled",
      "generation",
      "token",
    ]);
    assert.equal(enabled, true);
    assert.match(generation, /^[0-9a-f-]{36}$/);
    assert.match(token, /^[0-9a-f]{32}$/);
    // No launch wiring here: env, args and grants are untouched.
    assert.deepEqual(
      { ...prepared, sshAgent: undefined },
      {
        ...base(),
        sshAgent: undefined,
      },
    );
    const folder = sessionFolder(f.dataDir, id);
    const socketPath = agentSocketLocation(f.dataDir, id, token, { home }).socketPath;
    const details = f.agents.launchDetails(id);
    // Exactly: own folder, own socket, each resolved binary. Never allow, never a parent.
    assert.deepEqual(details.grants, [
      { access: "read", path: folder },
      { access: "socket", path: socketPath },
      ...Object.values(details.binaries).map((file) => ({ access: "read", path: file })),
    ]);
    assert.deepEqual(prepared.sshAgent.binaries, details.binaries);
    assert.equal(details.socketPath, socketPath);
    assert.equal(details.configPath, path.join(folder, "ssh_config"));
    assert.equal(details.binDir, path.join(folder, "bin"));
    assert.ok(path.isAbsolute(details.binaries.ssh));
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    assert.equal(fs.statSync(path.join(folder, "bin", "ssh")).mode & 0o777, 0o700);
    // A session's wrappers never refuse options (only an agent's do, owner A18).
    assert.doesNotMatch(
      fs.readFileSync(path.join(folder, "bin", "ssh"), "utf8"),
      /refuse/,
    );
    assert.equal(fs.existsSync(details.configPath), true);
  }
  assert.equal(SSH_CONFIG_ENV, "AGENTPIER_SSH_CONFIG");
  assert.equal(SSH_AGENT_SOCK_ENV, "AGENTPIER_SSH_AUTH_SOCK");
  assert.equal(SSH_AGENT_HINT_ENV, "AGENTPIER_SSH_AGENT");
  assert.equal(f.agents.launchDetails("unknown"), null);
});

test("one eligibility rule covers launches and records", () => {
  const cases = [
    [{ tool: "claude", sshTools: { enabled: true } }, true],
    [{ tool: "codex", sshTools: { enabled: true } }, true],
    [{ tool: "opencode", sshTools: { enabled: true } }, true],
    [{ tool: "claude", sshTools: { enabled: false } }, false],
    [{ tool: "claude" }, false],
    [{ tool: "shell" }, true],
    [{ tool: "shell", sshTools: { enabled: false, project } }, true],
    [{ tool: "shell", purpose: "login" }, false],
    [{ tool: "claude", purpose: "login", sshTools: { enabled: true } }, false],
    [
      { tool: "claude", pipeline: { headless: true }, sshTools: { enabled: true } },
      false,
    ],
    [{ tool: "claude", pipeline: { runId: "r" }, sshTools: { enabled: true } }, true],
    [{ tool: "shell", pipeline: { headless: false } }, true],
    [{ tool: "shell", pipeline: { headless: true } }, false],
    [{ tool: "openclaw", sshTools: { enabled: true } }, false],
    [{}, false],
    [undefined, false],
  ];
  for (const [value, expected] of cases)
    assert.equal(agentEligible(value), expected, JSON.stringify(value));
});

test("login, pipeline, tool-less, agent and old-OpenSSH launches are unchanged", async (t) => {
  const f = fixture(t);
  for (const variant of [
    { purpose: "login" },
    { pipeline: { headless: true } },
    { sshTools: { enabled: false } },
    { tool: "openclaw" },
    { tool: "shell", purpose: "login" },
  ]) {
    const request = input(variant);
    assert.deepEqual(await f.agents.prepare(request), request.launch);
    assert.equal(fs.existsSync(sessionFolder(f.dataDir, request.id)), false);
  }
  const old = new SessionSshAgents({ ...f.deps, openssh: { major: 8, minor: 4 } });
  const none = new SessionSshAgents({ ...f.deps, openssh: null });
  f.started.push(old, none);
  for (const [agents, reason] of [
    [old, "openssh-too-old"],
    [none, "no-openssh"],
  ]) {
    const request = input();
    assert.deepEqual(await agents.prepare(request), request.launch);
    assert.deepEqual(agents.status({ ...request, status: "running", tool: "claude" }), {
      state: "unavailable",
      reason,
      aliases: {},
    });
  }
  // Without an ssh binary on PATH there is nothing to wrap.
  const request = input({ env: { PATH: path.join(root, "empty") } });
  assert.deepEqual(await f.agents.prepare(request), request.launch);
  assert.deepEqual(
    f.agents.status({ id: request.id, status: "running", tool: "claude" }),
    {
      state: "unavailable",
      reason: "no-openssh",
      aliases: {},
    },
  );
  assert.equal(f.agents.status({ id: "x", status: "running" }).reason, "not-eligible");
});

test("an interactive pipeline session gets the agent", async (t) => {
  const f = fixture(t);
  const { prepared } = await launch(f, { pipeline: { runId: "run-1" } });
  assert.equal(prepared.sshAgent.enabled, true);
});

test("shell sessions get the agent without the SSH tools", async (t) => {
  const f = fixture(t);
  const { prepared, record } = await launch(f, {
    tool: "shell",
    sshTools: { enabled: false, project },
  });
  assert.equal(prepared.sshAgent.enabled, true);
  assert.equal(f.agents.status(record).state, "ready");
});

test("sync writes aliases for granted hosts and drops a revoked one", async (t) => {
  const f = fixture(t);
  const { id, record } = await launch(f);
  const configPath = f.agents.launchDetails(id).configPath;
  await f.grants.set(record, [hostA.id, hostB.id]);
  assert.equal(await f.agents.sync(record), "written");
  assert.equal(await f.agents.sync(record), "unchanged");
  const { aliases } = f.agents.status(record);
  assert.deepEqual(Object.keys(aliases).sort(), [hostA.id, hostB.id].sort());
  assert.equal(aliases[hostB.id], "database");
  assert.match(fs.readFileSync(configPath, "utf8"), /^Host database$/m);
  await f.grants.set(record, [hostA.id]);
  assert.equal(await f.agents.sync(record), "written");
  assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /database/);
  assert.deepEqual(Object.keys(f.agents.status(record).aliases), [hostA.id]);
  // A stopped session or an unknown one is left alone.
  assert.equal(await f.agents.sync({ ...record, status: "stopped" }), "unchanged");
  assert.equal(await f.agents.sync({ ...record, id: "other" }), "unchanged");
  assert.deepEqual(f.logs, []);
});

test("hosts that cannot be rendered are logged by id only", async (t) => {
  const f = fixture(t);
  f.accesses.push(host("access-nouser", "No user", { username: "" }));
  const { record } = await launch(f);
  await f.grants.set(record, [hostA.id, "access-nouser"]);
  await f.agents.sync(record);
  assert.deepEqual(f.logs, [
    ["warn", "Session SSH agent skipped hosts:", "access-nouser"],
  ]);
  const text = JSON.stringify(f.logs);
  assert.equal(text.includes(userKey.publicLine.split(" ")[1]), false);
});

test("authorization follows the record's status, generation and the live grants", async (t) => {
  const f = fixture(t);
  const request = input();
  f.ids.push(request.id);
  const prepared = await f.agents.prepare(request);
  const socketPath = f.agents.launchDetails(request.id).socketPath;
  // No record yet: the agent serves nothing.
  assert.deepEqual(await identitiesAt(socketPath), []);
  const record = {
    id: request.id,
    tool: "claude",
    status: "running",
    sshTools: prepared.sshTools,
    sshAgent: prepared.sshAgent,
  };
  f.save(record);
  await f.grants.set(record, [hostA.id]);
  assert.equal((await identitiesAt(socketPath)).length, 1);
  f.save({ ...record, sshAgent: { ...record.sshAgent, generation: randomUUID() } });
  assert.deepEqual(await identitiesAt(socketPath), []);
  f.save({ ...record, status: "stopped" });
  assert.deepEqual(await identitiesAt(socketPath), []);
  f.save({ ...record, purpose: "login" });
  assert.deepEqual(await identitiesAt(socketPath), []);
  f.save(record);
  await f.grants.set(record, []);
  assert.deepEqual(await identitiesAt(socketPath), []);
});

test("a signature is audited as ssh.connected, a refusal as ssh.denied", async (t) => {
  const f = fixture(t);
  const { id, record } = await launch(f);
  await f.grants.set(record, [hostA.id]);
  const client = await AgentClient.connect(f.agents.launchDetails(id).socketPath);
  t.after(() => client.close());
  const sid = randomBytes(32);
  const data = userauth({ sessionId: sid, keyBlob: userKey.blob });
  assert.equal(await client.signRaw(userKey.blob, data), 5);
  assert.equal(await client.bind({ hostKey, sessionId: sid }), 6);
  assert.ok((await client.sign(userKey.blob, data)).length > 0);
  assert.deepEqual(
    f.audit.map((row) => [row.action, row.sessionId, row.projectId, row.details]),
    [
      ["ssh.denied", id, "project-1", { code: "SSH_AGENT_UNBOUND" }],
      [
        "ssh.connected",
        id,
        "project-1",
        { accessId: hostA.id, hostName: hostA.name, count: 1 },
      ],
    ],
  );
});

test("identities are read only by a valid key id and never through a link", async (t) => {
  const f = fixture(t);
  assert.equal(f.agents.identity(keyId), userKey.privateText);
  for (const bad of ["../x", "", "../../etc/passwd", `${keyId}/..`, null])
    assert.throws(() => f.agents.identity(bad), { code: "SSH_AGENT_KEY_UNSUPPORTED" });
  const other = "99999999-1111-2222-3333-444444444444";
  const folder = path.join(f.dataDir, "ssh", "identities", other);
  fs.mkdirSync(folder, { mode: 0o700 });
  fs.symlinkSync(path.join(root, "user"), path.join(folder, "identity"));
  assert.throws(() => f.agents.identity(other));
});

test("a reload keeps the socket path and changes the generation", async (t) => {
  const f = fixture(t);
  const { id, prepared, record } = await launch(f);
  await f.grants.set(record, [hostA.id]);
  const socketPath = f.agents.launchDetails(id).socketPath;
  const again = await f.agents.prepare({
    id,
    account: { id: "account-1", tool: "claude" },
    launch: base(),
  });
  assert.equal(again.sshAgent.token, prepared.sshAgent.token);
  assert.notEqual(again.sshAgent.generation, prepared.sshAgent.generation);
  assert.equal(f.agents.launchDetails(id).socketPath, socketPath);
  // Until the record carries the new generation, nothing is served.
  assert.deepEqual(await identitiesAt(socketPath), []);
  f.save({ ...record, sshAgent: again.sshAgent });
  assert.equal((await identitiesAt(socketPath)).length, 1);
});

// A socket file nobody listens on: a child process bound it and was killed.
async function staleSocket(file) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("up"))`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.equal(fs.lstatSync(file).isSocket(), true);
}

test("restore listens again at the same path after a restart, replacing a stale socket", async (t) => {
  const f = fixture(t);
  const { id, record } = await launch(f);
  const stopped = await launch(f);
  f.save({ ...stopped.record, status: "stopped" });
  await f.grants.set(record, [hostA.id]);
  await f.agents.sync(record);
  const socketPath = f.agents.launchDetails(id).socketPath;
  const aliases = f.agents.status(record).aliases;
  await f.agents.close();
  assert.equal(fs.existsSync(socketPath), false);
  await staleSocket(socketPath);
  const again = new SessionSshAgents(f.deps);
  f.started.push(again);
  await again.restore();
  assert.equal(again.launchDetails(id).socketPath, socketPath);
  assert.equal((await identitiesAt(socketPath)).length, 1);
  assert.deepEqual(again.status(record).aliases, aliases);
  // Only running sessions come back.
  assert.equal(again.launchDetails(stopped.id), null);
  // A record with a malformed agent is skipped.
  const bad = {
    ...record,
    id: randomUUID(),
    sshAgent: { enabled: true, generation: "../x" },
  };
  f.save(bad);
  const third = new SessionSshAgents(f.deps);
  f.started.push(third);
  await again.close();
  await third.restore();
  assert.equal(third.launchDetails(bad.id), null);
  assert.equal((await identitiesAt(socketPath)).length, 1);
});

test("discard removes the session folder and the socket folder only", async (t) => {
  const f = fixture(t);
  const { id } = await launch(f);
  const other = await launch(f);
  const socketPath = f.agents.launchDetails(id).socketPath;
  await f.agents.discard(id);
  assert.equal(fs.existsSync(sessionFolder(f.dataDir, id)), false);
  assert.equal(fs.existsSync(path.dirname(socketPath)), false);
  assert.equal(f.agents.launchDetails(id), null);
  assert.equal(fs.existsSync(sessionFolder(f.dataDir, other.id)), true);
  assert.equal(fs.existsSync(f.agents.launchDetails(other.id).socketPath), true);
  // An invalid id touches nothing.
  await f.agents.discard("../x");
  await f.agents.discard("");
  assert.equal(fs.existsSync(path.join(f.dataDir, "ssh-agents")), true);
});

test("discard after a restart finds the socket folder through the record", async (t) => {
  const f = fixture(t);
  const { id } = await launch(f);
  const socketPath = f.agents.launchDetails(id).socketPath;
  await f.agents.close();
  await new SessionSshAgents(f.deps).discard(id);
  assert.equal(fs.existsSync(path.dirname(socketPath)), false);
  assert.equal(fs.existsSync(sessionFolder(f.dataDir, id)), false);
});

test("discard never follows a planted link", async (t) => {
  const f = fixture(t);
  const victim = path.join(root, `victim-${randomUUID()}`);
  fs.mkdirSync(path.join(victim, "nested"), { recursive: true });
  fs.writeFileSync(path.join(victim, "nested", "keep"), "keep");
  // A link inside the session folder is unlinked, not followed.
  const { id } = await launch(f);
  fs.symlinkSync(victim, path.join(sessionFolder(f.dataDir, id), "escape"));
  await f.agents.discard(id);
  assert.equal(fs.existsSync(sessionFolder(f.dataDir, id)), false);
  // The session folder itself as a link: only the link goes.
  const linked = randomUUID();
  fs.symlinkSync(victim, sessionFolder(f.dataDir, linked));
  await f.agents.discard(linked);
  assert.equal(fs.existsSync(sessionFolder(f.dataDir, linked)), false);
  // The parent as a link: nothing below it is touched.
  const agentsRoot = path.join(f.dataDir, "ssh-agents");
  fs.rmSync(agentsRoot, { recursive: true });
  fs.symlinkSync(victim, agentsRoot);
  await f.agents.discard("nested");
  assert.deepEqual(fs.readdirSync(path.join(victim, "nested")), ["keep"]);
  fs.unlinkSync(agentsRoot);
});

test("refresh coalesces concurrent calls into one pass", async (t) => {
  const f = fixture(t);
  const first = await launch(f);
  const second = await launch(f);
  await launch(f, { purpose: "login" });
  await f.grants.set(first.record, [hostA.id]);
  const synced = [];
  const sync = f.agents.sync.bind(f.agents);
  f.agents.sync = (session) => {
    synced.push(session.id);
    return sync(session);
  };
  await Promise.all([f.agents.refresh(), f.agents.refresh(), f.agents.refresh()]);
  assert.deepEqual(synced.sort(), [first.id, second.id].sort());
  assert.deepEqual(Object.keys(f.agents.status(first.record).aliases), [hostA.id]);
});

test("close stops listening and keeps the folders", async (t) => {
  const f = fixture(t);
  const { id } = await launch(f);
  const socketPath = f.agents.launchDetails(id).socketPath;
  await f.agents.close();
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(path.dirname(socketPath)), true);
  assert.equal(fs.existsSync(sessionFolder(f.dataDir, id)), true);
});
