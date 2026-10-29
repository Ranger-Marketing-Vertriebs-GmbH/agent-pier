import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { connectAgentShellSsh } from "../../server/application/agent-ssh-shell-wiring.js";
import { AssistantEvents } from "../../server/features/assistants/assistant-events.js";
import { owner, personal, setup, trusted } from "../helpers/agent-ssh-shell-fixture.js";
import { execFixture } from "../helpers/assistant-exec-fixture.js";
import { hostA, hostB } from "../helpers/ssh-session-agents-fixture.js";

// The agent SSH agents' wiring (agent-ssh-shell-wiring.js) on the fixture's registry,
// agents and access: a fake agent graph and SSH services, never the real ones.
function wired(t, { restored = Promise.resolve(), syncMs, live } = {}) {
  const s = setup(t);
  const events = new AssistantEvents();
  let published = null;
  let refreshes = 0;
  const graph = {
    assistants: {
      config: {},
      events,
      maintenance: false,
      store: {
        listAssistants: () => [...s.agents.keys()].map(s.get),
        getAssistant: s.get,
      },
    },
    assistantWorkflows: { access: s.access },
  };
  const services = {
    live,
    sshAgentRegistry: s.registry,
    sshAgentsRestored: restored,
    sshManagement: {
      store: {
        list: () => {
          if (w.failCatalog) throw Error("catalog unreadable");
          return [hostA, hostB];
        },
      },
      catalog: {
        onPublished(listener) {
          published = listener;
          return () => (published = null);
        },
      },
    },
  };
  const w = { failCatalog: false };
  const shell = connectAgentShellSsh(services, graph, { syncMs });
  const refresh = shell.refresh.bind(shell);
  shell.refresh = () => ((refreshes += 1), refresh());
  t.after(() => shell.close());
  // Lets a refresh queued by an event run to its end.
  const settled = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await s.registry.syncs.idle();
  };
  return Object.assign(w, {
    s,
    graph,
    shell,
    events,
    settled,
    publish: () => published?.(),
    refreshes: () => refreshes,
  });
}

test("without the SSH services or the agent graph nothing is wired", () => {
  assert.equal(connectAgentShellSsh({}, { assistants: { config: {} } }), null);
});

test("connect wires the hooks, refreshes on agent and catalog changes, and releases", async (t) => {
  const w = wired(t);
  const { s, graph, shell } = w;
  const config = graph.assistants.config;
  assert.equal(graph.assistantWorkflows.agentSsh, shell);
  assert.equal(typeof config.sshShellPath, "function");
  assert.equal(typeof config.plainSsh, "function");
  const a = s.add(personal(), [trusted(hostA)]);
  w.events.publish({ type: "change" });
  await w.settled();
  assert.equal(w.refreshes(), 1);
  assert.deepEqual(config.sshShellPath(s.get(a.id)), [path.join(s.folder(a), "bin")]);
  s.grants.set(a.id, []);
  w.publish();
  await w.settled();
  assert.equal(w.refreshes(), 2);
  assert.deepEqual(config.sshShellPath(s.get(a.id)), []);
  s.grants.set(a.id, [trusted(hostA)]);
  w.publish();
  await w.settled();
  // Shutdown: hooks and listeners go, the folder and token stay for the restart.
  await shell.close();
  assert.equal(config.sshShellPath, undefined);
  assert.equal(config.plainSsh, undefined);
  assert.equal(graph.assistantWorkflows.agentSsh, undefined);
  assert.equal(s.registry.get(owner(a)), undefined);
  assert.ok(fs.existsSync(s.state(a)));
  w.events.publish({ type: "change" });
  w.publish();
  await w.settled();
  assert.equal(w.refreshes(), 3);
});

test("each agent's SSH change signals its live topic until the wiring closes", async (t) => {
  const live = { invalidated: [], invalidate: (...args) => live.invalidated.push(args) };
  const w = wired(t, { live });
  const a = w.s.add(personal(), [trusted(hostA)]);
  await w.shell.refresh();
  assert.deepEqual(live.invalidated, [["agent.ssh-agent", a.id]]);
  // A revoke reaches the topic with the refresh that drops the alias.
  w.s.grants.set(a.id, []);
  await w.shell.refresh();
  assert.deepEqual(live.invalidated.at(-1), ["agent.ssh-agent", a.id]);
  const count = live.invalidated.length;
  await w.shell.close();
  w.s.registry.notify("agent", [a.id]);
  assert.equal(live.invalidated.length, count);
});

test("switching the feature off removes every agent folder and the hooks", async (t) => {
  const w = wired(t);
  const a = w.s.add(personal(), [trusted(hostA)]);
  await w.shell.refresh();
  assert.ok(fs.existsSync(w.s.folder(a)));
  await w.shell.discardAll();
  assert.equal(fs.existsSync(w.s.folder(a)), false);
  assert.equal(w.graph.assistants.config.sshShellPath, undefined);
  assert.equal(w.graph.assistantWorkflows.agentSsh, undefined);
});

test("each turn syncs first, so its instructions name the aliases of trusted hosts only", async (t) => {
  const w = wired(t);
  const { s, graph } = w;
  const plainSsh = (agent) => graph.assistants.config.plainSsh(s.get(agent.id));
  const a = s.add(personal(), [trusted(hostA), { accessId: hostB.id, mode: "approval" }]);
  // No event, no refresh yet: the turn's own sync starts the agent's socket.
  assert.deepEqual(await plainSsh(a), {
    hosts: [{ name: "Proxmox 2", alias: s.shell.aliases(a.id)[hostA.id] }],
  });
  assert.equal(Object.keys(w.shell.aliases(a.id)).length, 1);
  // Only approval hosts: the PATH entry stays (a mode switch never changes it), no
  // aliases. Without shell, or an agent of users: nothing at all.
  const approval = s.add(personal(), [{ accessId: hostA.id, mode: "approval" }]);
  assert.equal(await plainSsh(approval), null);
  assert.equal(graph.assistants.config.sshShellPath(s.get(approval.id)).length, 1);
  const off = s.add(personal({ shell: "off" }), [trusted(hostA)]);
  const user = s.add(personal({ userAccess: { mode: "shared" } }), [trusted(hostA)]);
  for (const agent of [off, user]) {
    assert.equal(await plainSsh(agent), null);
    assert.deepEqual(graph.assistants.config.sshShellPath(s.get(agent.id)), []);
  }
  // Archived: the next turn drops it.
  s.agents.set(a.id, { ...s.agents.get(a.id), archivedAt: new Date().toISOString() });
  assert.equal(await plainSsh(a), null);
  assert.deepEqual(graph.assistants.config.sshShellPath(s.get(a.id)), []);
});

test("a turn whose sync fails still gets an answer", async (t) => {
  const w = wired(t);
  const a = w.s.add(personal(), [trusted(hostA)]);
  w.shell.sync = async () => {
    throw Error("boom");
  };
  assert.equal(await w.graph.assistants.config.plainSsh(w.s.get(a.id)), null);
});

// The approval analysis resolves programs on the agent's exec PATH: GitHub dirs, its
// SSH bin/, then the owner's. The agent's own ssh and scp wrappers may be
// allowlisted (owner A16, exec-ssh-wrappers.js); its sftp and the owner's ssh stay
// allow-once (A18).
test("approval analysis resolves on the agent's SSH bin before the owner's PATH", async (t) => {
  const f = await execFixture(t);
  const bin = path.join(f.dataDir, "ssh-agents", "_agents", f.id, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["ssh", "scp", "sftp", "tool"])
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  const tool = fs.realpathSync(path.join(bin, "tool"));
  f.assistants.runtime.shell = { pathPrepend: [path.dirname(f.program("tool"))] };
  const ask = (id, command, resolvedPath) =>
    f.request(id, { command, resolvedPath, allowedDecisions: ["allow-once", "deny"] });
  // Without the agent's bin/ the owner's program is found, which is not what runs.
  assert.equal((await ask("without", "tool -v", tool)).allowAlwaysPlan.kind, "once");
  f.workflows.agentSsh = {
    shellDirs: (assistant) => (assistant.id === f.id ? [bin] : []),
  };
  const plan = (await ask("with", "tool -v", tool)).allowAlwaysPlan;
  assert.equal(plan.kind, "paths");
  assert.deepEqual(plan.paths, [tool]);
  for (const name of ["ssh", "scp"]) {
    const wrapper = fs.realpathSync(path.join(bin, name));
    assert.deepEqual(
      (await ask(name, `${name} proxmox-2:/x .`, wrapper)).allowAlwaysPlan,
      { kind: "paths", paths: [wrapper], writable: [wrapper] },
      name,
    );
  }
  // sftp runs `!command` from stdin or a batch file: its card asks every time (A18).
  const sftp = fs.realpathSync(path.join(bin, "sftp"));
  assert.deepEqual((await ask("sftp", "sftp proxmox-2", sftp)).allowAlwaysPlan, {
    kind: "once",
    reason: "interpreter",
    program: "sftp",
  });
  const ssh = fs.realpathSync(path.join(bin, "ssh"));
  assert.deepEqual(
    (await ask("proxy", "ssh -o ProxyCommand=x proxmox-2", ssh)).allowAlwaysPlan,
    { kind: "once", reason: "inline", program: "ssh" },
  );
  // Without the agent's SSH agent the owner's ssh is an interpreter again.
  const owners = path.join(path.dirname(f.program("tool")), "ssh");
  fs.writeFileSync(owners, "#!/bin/sh\n", { mode: 0o755 });
  f.workflows.agentSsh = { shellDirs: () => [] };
  assert.deepEqual(
    (await ask("owner-ssh", "ssh proxmox-2", fs.realpathSync(owners))).allowAlwaysPlan,
    { kind: "once", reason: "interpreter", program: "ssh" },
  );
});

test("a turn's sync touches only its own agent and never waits for a stuck queue", async (t) => {
  const w = wired(t, { syncMs: 50 });
  const { s, graph } = w;
  const plainSsh = (agent) => graph.assistants.config.plainSsh(s.get(agent.id));
  const a = s.add(personal(), [trusted(hostA)]);
  const b = s.add(personal(), [trusted(hostB)]);
  await w.shell.refresh();
  const socketB = s.socketPath(b);
  // b loses its shell; a's turn neither tears b down nor starts anyone else.
  s.agents.set(b.id, { ...s.agents.get(b.id), shell: "off" });
  const c = s.add(personal(), [trusted(hostA)]);
  assert.equal((await plainSsh(a)).hosts.length, 1);
  assert.equal(s.socketPath(b), socketB);
  assert.equal(s.registry.get(owner(c)), undefined);
  // b's own turn tears it down.
  assert.equal(await plainSsh(b), null);
  assert.equal(s.registry.get(owner(b)), undefined);
  // A session task that never finishes: the turn answers within the bound from the
  // status it has (a stays ready; c, never started, has nothing).
  let finish;
  s.registry.syncs.run(() => new Promise((resolve) => (finish = resolve)));
  const started = Date.now();
  assert.equal((await plainSsh(a)).hosts.length, 1);
  assert.equal(await plainSsh(c), null);
  assert.ok(Date.now() - started < 1000);
  finish();
  await s.registry.syncs.idle();
});

test("an unreadable catalog still names the aliases, by alias", async (t) => {
  const w = wired(t);
  const a = w.s.add(personal(), [trusted(hostA)]);
  await w.shell.refresh();
  const alias = w.shell.aliases(a.id)[hostA.id];
  assert.ok(alias);
  // The catalog fails after the files were written (a write while it fails would
  // clear the aliases, ssh-agent-registry.js): this turn's sync already ran.
  w.shell.sync = async () => {};
  w.failCatalog = true;
  assert.deepEqual(await w.graph.assistants.config.plainSsh(w.s.get(a.id)), {
    hosts: [{ name: alias, alias }],
  });
});

test("a turn's sync changes nothing when its agent cannot be read or is gone", async (t) => {
  const w = wired(t);
  const { s, shell } = w;
  const a = s.add(personal(), [trusted(hostA)]);
  await shell.refresh();
  const socket = s.socketPath(a);
  const get = s.get;
  // An unreadable store: the agent keeps its socket and folder.
  shell.agents.get = () => {
    throw Error("database is locked");
  };
  await shell.sync(a.id);
  assert.equal(s.socketPath(a), socket);
  // Deleted: the turn's sync leaves it; the next full refresh tears it down.
  shell.agents.get = get;
  s.agents.delete(a.id);
  await shell.sync(a.id);
  assert.equal(s.socketPath(a), socket);
  await shell.refresh();
  assert.equal(s.registry.get(owner(a)), undefined);
  assert.equal(fs.existsSync(s.folder(a)), false);
});
