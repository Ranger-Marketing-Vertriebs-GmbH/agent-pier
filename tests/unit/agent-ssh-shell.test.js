import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AgentShellSsh,
  agentShellEnv,
  agentSshEligible,
  agentSshModes,
} from "../../server/features/assistants/agent-ssh-shell.js";
import { sshFromLead } from "../../server/features/assistants/assistant-access.js";
import { personalEligible } from "../../server/features/assistants/native-capabilities.js";
import { SshAgentRegistry } from "../../server/features/ssh/ssh-agent-registry.js";
import {
  agentSocketLocation,
  newAgentToken,
} from "../../server/features/ssh/ssh-agent-socket.js";
import { ownerFolder } from "../../server/features/ssh/ssh-session-config.js";
import {
  home,
  hostA,
  hostB,
  identitiesAt,
  root,
} from "../helpers/ssh-session-agents-fixture.js";

const owner = (agent) => ({ kind: "agent", id: agent.id });
const personal = (extra = {}) => ({ id: randomUUID(), shell: "approval", ...extra });

let counter = 0;
// One data dir per test: fake agents, grants and access (mirroring AssistantAccess:
// sshHolder refuses an archived lead, sshAgents lists holders with a grant), a
// recorded dispatcher, listeners and session token reads; the home is a /tmp stand-in.
function setup(t, { openssh = { major: 10, minor: 2 }, pathEnv, restored } = {}) {
  counter += 1;
  const dataDir = path.join(root, `agent-shell-${counter}`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const s = {
    dataDir,
    agents: new Map(),
    grants: new Map(),
    maintenance: false,
    sessionTokens: [],
    sessionReads: 0,
    heard: [],
    updates: 0,
    logs: [],
    instances: [],
  };
  s.access = {
    sshHolder(id) {
      const a = s.agents.get(id);
      const holder = a && sshFromLead(a) ? s.agents.get(a.parentAssistantId) : a;
      if (!holder || !personalEligible(holder)) throw new Error("invalid");
      return holder;
    },
    get: (id) => ({ sshAccesses: s.grants.get(id) ?? [] }),
    sshAgents() {
      const ids = [...s.agents.keys()].filter((id) => {
        try {
          return s.access.get(s.access.sshHolder(id).id).sshAccesses.length > 0;
        } catch {
          return false;
        }
      });
      return new Set(ids);
    },
  };
  s.add = (agent, grants) => {
    s.agents.set(agent.id, agent);
    if (grants) s.grants.set(agent.id, grants);
    return agent;
  };
  s.build = () => {
    const log = {
      warn: (...args) => s.logs.push(["warn", ...args]),
      error: (...args) => s.logs.push(["error", ...args]),
    };
    const registry = new SshAgentRegistry({
      dataDir,
      audit: { append() {} },
      openssh,
      home,
      log,
      userConfig: { update: () => (s.updates += 1), problemFor: () => null },
    });
    registry.tokenSource("session", () => {
      s.sessionReads += 1;
      return s.sessionTokens;
    });
    registry.listen("agent", (id) => s.heard.push(id));
    const shell = new AgentShellSsh({
      registry,
      agents: { list: () => [...s.agents.values()], get: (id) => s.agents.get(id) },
      store: { list: () => [hostA, hostB] },
      access: s.access,
      maintenance: () => s.maintenance,
      restored,
      pathEnv,
      log,
    });
    s.instances.push({ registry, shell });
    Object.assign(s, { registry, shell });
    return s;
  };
  s.folder = (agent) => ownerFolder(dataDir, owner(agent));
  s.socketPath = (agent) => s.registry.get(owner(agent))?.location.socketPath;
  s.tokenFolder = (agent, token) =>
    path.dirname(agentSocketLocation(dataDir, agent.id, token, { home }).socketPath);
  t.after(async () => {
    for (const { shell, registry } of s.instances) {
      await shell.close();
      await registry.close();
    }
    const last = s.build();
    await last.shell.discardAll();
  });
  return s.build();
}

const trusted = (access) => ({ accessId: access.id, mode: "trusted" });

test("only trusted and routines grants enter the socket and get an alias", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA), { accessId: hostB.id, mode: "approval" }]);
  await s.shell.refresh();
  assert.deepEqual(agentSshModes, ["trusted", "routines"]);
  assert.deepEqual(Object.keys(s.shell.aliases(a.id)), [hostA.id]);
  const grant = await s.shell.authorize(a.id);
  assert.deepEqual(
    grant.hosts.map((h) => h.accessId),
    [hostA.id],
  );
  assert.equal((await identitiesAt(s.socketPath(a))).length, 1);
  // A legacy "routines" grant counts as trusted.
  s.grants.set(a.id, [{ accessId: hostB.id, mode: "routines" }]);
  assert.deepEqual(
    (await s.shell.authorize(a.id)).hosts.map((h) => h.accessId),
    [hostB.id],
  );
});

test("no shell, a user agent, an archived agent and a member without SSH get nothing", async (t) => {
  const s = setup(t);
  const lead = s.add(personal({ shell: "full" }), [trusted(hostA)]);
  const archivedLead = s.add(personal({ archivedAt: "2026-10-29T00:00:00Z" }), [
    trusted(hostA),
  ]);
  const member = (inherited, parent = lead) => ({
    id: randomUUID(),
    teamMemberId: "team-1",
    lifetime: "temporary",
    parentAssistantId: parent.id,
    inherited: { capabilities: {}, skills: [], ...inherited },
  });
  const cases = [
    [personal({ shell: "off" }), "no-shell"],
    [personal({ userAccess: { mode: "shared" } }), "not-eligible"],
    [personal({ archivedAt: "2026-10-29T00:00:00Z" }), "not-eligible"],
    [member({ ssh: false, shell: "full" }), "not-eligible"],
    [member({ ssh: true, shell: "off" }), "no-shell"],
    [member({ ssh: true, shell: "full" }, archivedLead), "no-hosts"],
  ];
  for (const [agent, reason] of cases) {
    s.add(agent, [trusted(hostA)]);
    await s.shell.refresh();
    assert.deepEqual(s.shell.shellPath(agent), [], reason);
    assert.equal(fs.existsSync(s.folder(agent)), false);
    assert.equal(s.registry.get(owner(agent)), undefined);
    assert.equal(await s.shell.authorize(agent.id), null);
    assert.deepEqual(s.shell.status(agent.id), { state: "unavailable", reason });
  }
  assert.equal(agentSshEligible(lead, s.access.sshAgents()), true);
  assert.equal(agentSshEligible(lead, new Set()), false);
});

test("a temporary member uses its lead's trusted hosts, read live, while the lead shares SSH", async (t) => {
  const s = setup(t);
  const lead = s.add(personal({ shell: "full" }), [
    { accessId: hostA.id, mode: "routines" },
    { accessId: hostB.id, mode: "approval" },
  ]);
  const m = s.add({
    id: randomUUID(),
    teamMemberId: "team-1",
    lifetime: "temporary",
    parentAssistantId: lead.id,
    inherited: { ssh: true, shell: "approval", capabilities: {}, skills: [] },
  });
  await s.shell.refresh();
  assert.deepEqual(Object.keys(s.shell.aliases(m.id)), [hostA.id]);
  assert.deepEqual(s.shell.shellPath(m), [path.join(s.folder(m), "bin")]);
  // The lead revokes the host: the member's next signature has no host.
  s.grants.set(lead.id, [{ accessId: hostB.id, mode: "approval" }]);
  assert.deepEqual((await s.shell.authorize(m.id)).hosts, []);
  // The lead stops sharing SSH: refused at once, torn down at the next refresh.
  s.add({ ...m, inherited: { ...m.inherited, ssh: false } });
  assert.equal(await s.shell.authorize(m.id), null);
  await s.shell.refresh();
  assert.equal(s.registry.get(owner(m)), undefined);
  assert.equal(fs.existsSync(s.folder(m)), false);
});

test("switching a host to With approval refuses at once and keeps PATH", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  const before = s.shell.shellPath(a);
  assert.deepEqual(before, [path.join(s.folder(a), "bin")]);
  assert.deepEqual(s.shell.shellDirs(a), before);
  s.grants.set(a.id, [{ accessId: hostA.id, mode: "approval" }]);
  // Before any refresh.
  assert.equal((await s.shell.authorize(a.id)).hosts.length, 0);
  await s.shell.refresh();
  assert.deepEqual(s.shell.shellPath(a), before);
  assert.deepEqual(s.shell.shellPaths([a, personal()]), { [a.id]: before });
  assert.deepEqual(s.shell.status(a.id), { state: "ready", aliases: {} });
  // Revoking the last grant refuses at once and tears down at the next refresh.
  s.grants.set(a.id, []);
  assert.equal(await s.shell.authorize(a.id), null);
  await s.shell.refresh();
  assert.deepEqual(s.shell.shellPath(a), []);
  assert.deepEqual(s.shell.status(a.id), { state: "unavailable", reason: "no-hosts" });
});

test("maintenance refuses every signature", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  s.maintenance = true;
  assert.equal(await s.shell.authorize(a.id), null);
  s.maintenance = false;
  assert.equal((await s.shell.authorize(a.id)).hosts.length, 1);
});

test("archiving or deleting an agent tears its socket, folder and token folder down", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  const b = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  const tokenA = s.registry.get(owner(a)).token;
  const tokenB = s.registry.get(owner(b)).token;
  s.add({ ...a, archivedAt: "2026-10-29T00:00:00Z" });
  s.agents.delete(b.id);
  assert.equal(await s.shell.authorize(a.id), null);
  assert.equal(await s.shell.authorize(b.id), null);
  await s.shell.refresh();
  for (const [agent, token] of [
    [a, tokenA],
    [b, tokenB],
  ]) {
    assert.equal(s.registry.get(owner(agent)), undefined);
    assert.equal(fs.existsSync(s.folder(agent)), false);
    assert.equal(fs.existsSync(s.tokenFolder(agent, token)), false);
  }
});

test("folders of agents that are gone are removed with their token folder", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  const socketFolder = path.dirname(s.socketPath(a));
  await s.shell.close();
  // Gone while AgentPier was down; a stray non-id entry goes, too.
  s.agents.delete(a.id);
  const stray = path.join(path.dirname(s.folder(a)), "Not An Id");
  fs.mkdirSync(stray);
  s.build();
  await s.shell.refresh();
  assert.equal(fs.existsSync(s.folder(a)), false);
  assert.equal(fs.existsSync(socketFolder), false);
  assert.equal(fs.existsSync(stray), false);
});

test("a restart reuses the stored token unless another owner holds it", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  const first = s.registry.get(owner(a));
  const state = path.join(s.folder(a), "state.json");
  assert.equal(fs.statSync(state).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(state, "utf8")), { token: first.token });
  // A restart keeps the folder and listens at the same path.
  await s.shell.close();
  await s.registry.close();
  assert.equal(fs.existsSync(state), true);
  s.build();
  await s.shell.refresh();
  assert.equal(s.socketPath(a), first.location.socketPath);
  // A token a session keeps is never taken over.
  await s.shell.close();
  await s.registry.close();
  const sessionToken = newAgentToken();
  s.sessionTokens = [{ id: "session-1", token: sessionToken }];
  fs.writeFileSync(state, JSON.stringify({ token: sessionToken }));
  s.build();
  await s.shell.refresh();
  const third = s.registry.get(owner(a)).token;
  assert.notEqual(third, sessionToken);
  assert.deepEqual(JSON.parse(fs.readFileSync(state, "utf8")), { token: third });
});

test("an unsafe or invalid state.json never names the token", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  const state = path.join(s.folder(a), "state.json");
  const token = s.registry.get(owner(a)).token;
  const outside = path.join(s.dataDir, "outside.json");
  const contents = [
    () => fs.writeFileSync(state, JSON.stringify({ token: "../../x" })),
    () => fs.writeFileSync(state, JSON.stringify({ token, pad: "x".repeat(5000) })),
    () => {
      fs.writeFileSync(outside, JSON.stringify({ token }));
      fs.rmSync(state);
      fs.symlinkSync(outside, state);
    },
  ];
  let last = token;
  for (const plant of contents) {
    await s.shell.close();
    await s.registry.close();
    plant();
    s.build();
    await s.shell.refresh();
    const now = s.registry.get(owner(a)).token;
    assert.notEqual(now, last);
    assert.equal(fs.lstatSync(state).isFile(), true);
    last = now;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(outside, "utf8")), { token });
});

test("close keeps folders and tokens; discardAll removes them", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  const token = s.registry.get(owner(a)).token;
  await s.shell.close();
  assert.equal(s.registry.get(owner(a)), undefined);
  assert.equal(fs.existsSync(s.folder(a)), true);
  // A closed adapter starts nothing.
  await s.shell.refresh();
  assert.equal(s.registry.get(owner(a)), undefined);
  s.build();
  await s.shell.refresh();
  assert.equal(s.registry.get(owner(a)).token, token);
  await s.shell.discardAll();
  assert.equal(s.registry.get(owner(a)), undefined);
  assert.equal(fs.existsSync(s.folder(a)), false);
  assert.equal(fs.existsSync(s.tokenFolder(a, token)), false);
});

test("a refresh writes quietly, notifies once and reads the kept tokens once", async (t) => {
  const s = setup(t);
  const agents = [1, 2, 3].map(() => s.add(personal(), [trusted(hostA)]));
  s.sessionReads = 0;
  await s.shell.refresh();
  assert.equal(s.updates, 1);
  assert.deepEqual(s.heard.sort(), agents.map((a) => a.id).sort());
  assert.equal(s.sessionReads, 1);
  // Nothing changed: no update, no event.
  await s.shell.refresh();
  assert.equal(s.updates, 1);
  assert.equal(s.heard.length, 3);
});

test("the first refresh waits for the sessions' restore", async (t) => {
  let release;
  const restored = new Promise((resolve) => (release = resolve));
  const s = setup(t, { restored });
  const a = s.add(personal(), [trusted(hostA)]);
  let done = false;
  const pass = s.shell.refresh().then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false);
  assert.equal(s.registry.get(owner(a)), undefined);
  release();
  await pass;
  assert.ok(s.registry.get(owner(a)));
});

test("shell-env.sh keeps set variables and quotes paths", () => {
  const text = agentShellEnv({
    socketPath: "/tmp/a b/agent.sock",
    configPath: "/d/it's/ssh_config",
    binDir: "/d/bin",
  });
  assert.match(
    text,
    /\[ -n "\$\{SSH_AUTH_SOCK\+x\}" \] \|\| export SSH_AUTH_SOCK='\/tmp\/a b\/agent.sock'/,
  );
  assert.match(text, /export AGENTPIER_SSH_CONFIG='\/d\/it'\\''s\/ssh_config'/);
  const file = path.join(root, `env-${counter}.sh`);
  fs.writeFileSync(file, text);
  const run = (env) =>
    execFileSync(
      "/bin/sh",
      [
        "-c",
        `. "$1"; printf '%s|%s|%s|%s|%s' "$SSH_AUTH_SOCK" "$GIT_SSH_COMMAND" "$RSYNC_RSH" "$AGENTPIER_SSH_CONFIG" "$AGENTPIER_SSH_AUTH_SOCK"`,
        "sh",
        file,
      ],
      { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" },
    ).split("|");
  assert.deepEqual(run({}), [
    "/tmp/a b/agent.sock",
    "'/d/bin/ssh'",
    "'/d/bin/ssh'",
    "/d/it's/ssh_config",
    "/tmp/a b/agent.sock",
  ]);
  // A preset agent, Git command or rsync shell stays; the hints are always set.
  assert.deepEqual(
    run({ SSH_AUTH_SOCK: "/own.sock", GIT_SSH_COMMAND: "ssh -v", RSYNC_RSH: "" }),
    ["/own.sock", "ssh -v", "", "/d/it's/ssh_config", "/tmp/a b/agent.sock"],
  );
});

test("status is unavailable with a reason and never names a path or token", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  const noShell = s.add(personal({ shell: "off" }), [trusted(hostA)]);
  const noHosts = s.add(personal());
  await s.shell.refresh();
  assert.deepEqual(s.shell.status(noShell.id), {
    state: "unavailable",
    reason: "no-shell",
  });
  assert.deepEqual(s.shell.status(noHosts.id), {
    state: "unavailable",
    reason: "no-hosts",
  });
  assert.deepEqual(s.shell.status("../x"), {
    state: "unavailable",
    reason: "not-eligible",
  });
  const ready = s.shell.status(a.id);
  assert.equal(ready.state, "ready");
  assert.deepEqual(Object.keys(ready.aliases), [hostA.id]);
  assert.doesNotMatch(JSON.stringify(ready), /agent\.sock|ssh-agents|[0-9a-f]{32}/);
  assert.equal(
    fs.readFileSync(path.join(s.folder(a), "shell-env.sh"), "utf8").length > 0,
    true,
  );
});

test("without OpenSSH 8.9 or an ssh on PATH no agent gets a socket", async (t) => {
  const old = setup(t, { openssh: { major: 8, minor: 8 } });
  const a = old.add(personal(), [trusted(hostA)]);
  await old.shell.refresh();
  assert.equal(old.registry.get(owner(a)), undefined);
  assert.deepEqual(old.shell.status(a.id), {
    state: "unavailable",
    reason: "openssh-too-old",
  });
  const none = setup(t, { openssh: null });
  none.add(a, [trusted(hostA)]);
  await none.shell.refresh();
  assert.deepEqual(none.shell.status(a.id), {
    state: "unavailable",
    reason: "no-openssh",
  });
  const missing = setup(t, { pathEnv: path.join(root, "no-such-bin") });
  missing.add(a, [trusted(hostA)]);
  await missing.shell.refresh();
  assert.equal(missing.registry.get(owner(a)), undefined);
  assert.deepEqual(missing.shell.status(a.id), {
    state: "unavailable",
    reason: "no-openssh",
  });
  assert.deepEqual(missing.heard, [a.id]);
});

test("a planted link at _agents fails the start, writes nothing through it and says failed", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  const target = path.join(s.dataDir, "elsewhere");
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(s.dataDir, "ssh-agents"), { mode: 0o700 });
  fs.symlinkSync(target, path.join(s.dataDir, "ssh-agents", "_agents"));
  await s.shell.refresh();
  assert.equal(s.registry.get(owner(a)), undefined);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.deepEqual(s.shell.status(a.id), { state: "unavailable", reason: "failed" });
  assert.deepEqual(s.shell.shellPath(a), []);
  assert.ok(s.logs.some(([, message]) => /could not be started/.test(message)));
  fs.rmSync(path.join(s.dataDir, "ssh-agents", "_agents"));
});
