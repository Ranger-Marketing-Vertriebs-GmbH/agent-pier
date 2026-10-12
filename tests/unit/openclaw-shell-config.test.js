import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";
import { shellSections } from "../../server/features/assistants/openclaw-config/shell.js";
import {
  execShellScript,
  ownerShellEnvironment,
  writeExecShell,
} from "../../server/features/assistants/exec-shell.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON } from "../../server/lib/storage.js";
import { mergeGateway } from "../helpers/assistant-shell-service.js";

// docs/assistant-shell-qualification.md: per-agent exec modes over a global "deny"
// (b), exec and process in the global tools.allow only while an agent has shell
// (c), the exec shell wrapper and pathPrepend (d), strictInlineEval for "approval"
// only (f). Owner homes are temporary directories, never the developer's own.

const ownerPath = ["/owner/bin", "/opt/homebrew/bin"];
const paths = { workspaces: "/w", logs: "/l" };
const profile = (shell, extra = {}) => ({
  id: `a-${shell}`,
  runtimeAgentId: `ap-${shell}`,
  capabilities: { memory: false, reminders: false },
  ...(shell && { shell }),
  ...extra,
});
const teams = (profiles) => ({
  directory: "/plugin",
  connection: { url: "http://127.0.0.1:1", token: "bridge" },
  hostMaxConcurrent: 4,
  native: { token: "hook" },
  profiles,
});
const compile = (profiles, existing) =>
  compileOpenClawConfig({
    existing: existing && structuredClone(existing),
    paths,
    port: 1234,
    token: "t",
    teams: teams(profiles),
    shell: { pathPrepend: ownerPath },
  });
const entries = (profiles) =>
  Object.fromEntries(profiles.map((p) => [p.runtimeAgentId, { id: p.runtimeAgentId }]));
const seeded = (profiles) => ({
  ...compile([]),
  agents: { ...compile([]).agents, entries: entries(profiles) },
});
const tempDir = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("without an agent with shell only the global deny floor is added", () => {
  const profiles = [profile(undefined), profile("off")];
  const config = compile(profiles, seeded(profiles));
  assert.deepEqual(config.tools.exec, { mode: "deny" });
  assert.ok(!config.tools.allow.includes("exec"));
  assert.ok(!config.tools.allow.includes("process"));
  for (const entry of Object.values(config.agents.entries)) {
    assert.equal(entry.tools.exec, undefined);
    assert.ok(!entry.tools.allow.includes("exec"));
  }
  // An unset level compiles exactly like "off".
  const [unset, off] = Object.values(config.agents.entries);
  assert.deepEqual(unset.tools, off.tools);
  // Without the team plugin the floor is there as well.
  const plain = compileOpenClawConfig({ paths, port: 1, token: "t" });
  assert.deepEqual(plain.tools, {
    allow: ["session_status"],
    toolSearch: false,
    exec: { mode: "deny" },
    sessions: { visibility: "agent" },
  });
});

test("approval asks with strict inline eval, full runs; both get exec and process", () => {
  const profiles = [profile("approval"), profile("full"), profile("off")];
  const config = compile(profiles, seeded(profiles));
  assert.deepEqual(config.tools.exec, { mode: "deny" });
  assert.deepEqual(config.tools.allow.slice(-2), ["exec", "process"]);
  const {
    "ap-approval": approval,
    "ap-full": full,
    "ap-off": off,
  } = config.agents.entries;
  assert.deepEqual(approval.tools.exec, {
    mode: "ask",
    strictInlineEval: true,
    pathPrepend: ownerPath,
  });
  assert.deepEqual(full.tools.exec, { mode: "full", pathPrepend: ownerPath });
  for (const entry of [approval, full])
    assert.deepEqual(entry.tools.allow.slice(-2), ["exec", "process"]);
  assert.equal(off.tools.exec, undefined);
  assert.ok(!off.tools.allow.includes("exec"));
  assert.deepEqual(shellSections({ profiles }), { globalTools: ["exec", "process"] });
});

test("temporary members, archived agents and foreign entries never keep shell", () => {
  const temporary = profile("full", {
    id: "tmp",
    runtimeAgentId: "ap-tmp",
    teamMemberId: "m",
    lifetime: "temporary",
  });
  const archived = profile("approval", {
    id: "old",
    runtimeAgentId: "ap-old",
    archivedAt: "2026-10-01T00:00:00.000Z",
  });
  const existing = seeded([temporary, archived]);
  existing.agents.entries.foreign = {
    id: "foreign",
    tools: { allow: ["session_status", "exec", "process"], exec: { mode: "full" } },
  };
  const config = compile([temporary, archived], existing);
  assert.deepEqual(shellSections({ profiles: [temporary, archived] }).globalTools, []);
  assert.ok(!config.tools.allow.includes("exec"));
  for (const entry of Object.values(config.agents.entries)) {
    assert.equal(entry.tools.exec, undefined, entry.id);
    assert.ok(!entry.tools.allow.includes("exec"), entry.id);
    assert.ok(!entry.tools.allow.includes("process"), entry.id);
  }
  // A permanent team member is configured like a personal agent.
  const permanent = profile("full", { teamMemberId: "m", lifetime: "permanent" });
  assert.equal(
    compile([permanent], seeded([permanent])).agents.entries["ap-full"].tools.exec.mode,
    "full",
  );
});

test("a start and a live entry grant the same shell", () => {
  for (const shell of ["off", "approval", "full"]) {
    const p = profile(shell);
    const started = compile([p], seeded([p])).agents.entries[p.runtimeAgentId];
    const live = agentEntry({ id: p.runtimeAgentId }, p, {
      teamsReady: true,
      nativeReady: true,
      guardProven: false,
      pathPrepend: ownerPath,
    });
    assert.deepEqual(live.tools, started.tools, shell);
  }
  // Without native readiness neither exec nor its override is granted.
  const notReady = agentEntry({}, profile("full"), {
    teamsReady: true,
    nativeReady: false,
    guardProven: false,
    pathPrepend: ownerPath,
  });
  assert.equal(notReady.tools.exec, undefined);
  assert.ok(!notReady.tools.allow.includes("exec"));
});

test("a live apply raises and lowers shell with the global list in one patch", async (t) => {
  const dataDir = tempDir(t, "assistant-shell-live-");
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const create = (name) =>
    store.createAssistant({ name, model: { connectionId: "c", modelId: "m" } });
  let agent = create("Shell");
  const other = create("Other");
  const started = compile([agent, other], seeded([agent, other]));
  started.agents.entries[agent.runtimeAgentId].model = "c/m";
  started.agents.entries[other.runtimeAgentId].model = "c/m";
  const client = mergeGateway(started);
  const config = new AssistantConfig({
    client,
    store,
    workspaces: dataDir,
    teamReady: () => true,
    models: { resolve: () => ({ modelRef: "c/m", release() {} }) },
  });
  Object.assign(config, {
    nativeReady: () => true,
    writeGuard: () => false,
    webToolsAvailable: () => ({}),
    shellPathPrepend: () => ownerPath,
  });
  const live = () => client.effective();
  const update = (patch) =>
    (agent = store.updateAssistant(
      agent.id,
      patch,
      store.getAssistant(agent.id).revision,
    ));

  update({ shell: "approval" });
  await config.apply(agent.id);
  let entry = live().agents.entries[agent.runtimeAgentId];
  assert.deepEqual(entry.tools.exec, {
    mode: "ask",
    strictInlineEval: true,
    pathPrepend: ownerPath,
  });
  assert.deepEqual(live().tools.allow.slice(-2), ["exec", "process"]);
  assert.deepEqual(live().tools.exec, { mode: "deny" });
  // The same agent compiled at a start yields the same entry tools and global list.
  const restarted = compile(store.listAssistants(), live());
  assert.deepEqual(restarted.agents.entries[agent.runtimeAgentId].tools, entry.tools);
  assert.deepEqual(restarted.tools.allow, live().tools.allow);

  // Another agent's apply leaves the global list alone.
  const before = client.patches.length;
  await config.apply(other.id);
  assert.equal(client.patches.at(-1).patch.tools, undefined);
  assert.equal(client.patches.length, before + 1);

  // Every transition between the levels, both directions. The double merges like
  // OpenClaw (existing keys first), so full -> approval stores strictInlineEval last.
  const expected = {
    off: undefined,
    approval: { mode: "ask", strictInlineEval: true, pathPrepend: ownerPath },
    full: { mode: "full", pathPrepend: ownerPath },
  };
  let previous = "approval";
  for (const level of ["full", "approval", "off", "full", "off", "approval", "off"]) {
    update({ shell: level });
    await config.apply(agent.id);
    entry = live().agents.entries[agent.runtimeAgentId];
    assert.deepEqual(entry.tools.exec, expected[level], level);
    assert.equal(entry.tools.allow.includes("exec"), level !== "off", level);
    assert.equal(live().tools.allow.includes("exec"), level !== "off", level);
    assert.equal(store.getAssistant(agent.id).effectiveRevision, agent.revision, level);
    if (previous === "full" && level === "approval")
      assert.deepEqual(Object.keys(entry.tools.exec), [
        "mode",
        "pathPrepend",
        "strictInlineEval",
      ]);
    previous = level;
  }
  assert.equal(entry.tools.exec, undefined);
  assert.ok(!entry.tools.allow.includes("exec"));
  assert.ok(!live().tools.allow.includes("exec"));
  assert.ok(!live().tools.allow.includes("process"));
  assert.deepEqual(client.patches.at(-1).replacePaths, [
    `agents.entries.${agent.runtimeAgentId}.tools.allow`,
    `agents.entries.${agent.runtimeAgentId}.tools.exec.pathPrepend`,
    `agents.entries.${agent.runtimeAgentId}.memory.search.sources`,
    "tools.allow",
  ]);
  const stopped = compile(store.listAssistants(), live());
  assert.deepEqual(stopped.agents.entries[agent.runtimeAgentId].tools, entry.tools);
  assert.deepEqual(stopped.tools.allow, live().tools.allow);
});

test("a live apply whose exec override did not stick is a conflict", async (t) => {
  const dataDir = tempDir(t, "assistant-shell-conflict-");
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const agent = store.createAssistant({
    name: "Shell",
    model: { connectionId: "c", modelId: "m" },
    shell: "full",
  });
  const client = mergeGateway({
    tools: { allow: ["session_status"] },
    agents: { entries: { [agent.runtimeAgentId]: { model: "c/m" } } },
  });
  const call = client.call;
  client.call = async (method, params) => {
    if (method !== "config.patch") return call(method, params);
    const patch = JSON.parse(params.raw);
    delete patch.agents.entries[agent.runtimeAgentId].tools.exec;
    return call(method, { ...params, raw: JSON.stringify(patch) });
  };
  const config = new AssistantConfig({
    client,
    store,
    workspaces: dataDir,
    teamReady: () => true,
    models: { resolve: () => ({ modelRef: "c/m", release() {} }) },
  });
  Object.assign(config, {
    nativeReady: () => true,
    writeGuard: () => false,
    webToolsAvailable: () => ({}),
    shellPathPrepend: () => [],
  });
  await assert.rejects(config.apply(agent.id), { status: 409 });
  assert.equal(store.getAssistant(agent.id).effectiveRevision, 0);
});

test("the wrapper sets a quoted owner HOME and is read-only for the owner", (t) => {
  const dir = tempDir(t, "assistant-exec-shell-");
  for (const name of ['it\'s $HOME `id` "q" \\ ;x', "line\nbreak", "plain"]) {
    const home = path.join(dir, name);
    fs.mkdirSync(home);
    const paths = { root: dir };
    const wrapper = writeExecShell(paths, home);
    // Named "sh", so OpenClaw's system prompt names the shell that actually runs.
    assert.equal(wrapper, path.join(dir, "exec-shell", "sh"));
    assert.equal(fs.statSync(path.dirname(wrapper)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(wrapper).mode & 0o777, 0o500);
    assert.equal(fs.readFileSync(wrapper, "utf8"), execShellScript(home));
    // The wrapper hands its arguments to /bin/sh like a login shell would get them.
    const seen = execFileSync(wrapper, ["-c", 'printf %s "$HOME"'], {
      env: { PATH: "/usr/bin:/bin", HOME: dir },
      encoding: "utf8",
    });
    assert.equal(seen, home, JSON.stringify(name));
    // Rewritten atomically on each start: no temporary files remain.
    assert.deepEqual(fs.readdirSync(path.dirname(wrapper)), ["sh"]);
  }
  assert.match(
    execShellScript("/h"),
    /^#!\/bin\/sh\nexport HOME='\/h'\nexec \/bin\/sh "\$@"\n$/,
  );
  assert.throws(() => execShellScript("relative/home"));
  const shells = fs.existsSync("/etc/shells")
    ? fs.readFileSync("/etc/shells", "utf8")
    : "";
  assert.ok(!shells.split("\n").includes(path.join(dir, "exec-shell", "sh")));
});

test("the owner's HOME comes from the account, the PATH from the service", () => {
  const present = new Set([
    "/svc/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);
  const owner = ownerShellEnvironment({
    env: { HOME: "/overridden", PATH: "/svc/bin::relative:/usr/bin:/svc/bin:/gone" },
    userInfo: () => ({ homedir: "/Users/owner" }),
    exists: (dir) => present.has(dir),
  });
  assert.deepEqual(owner, {
    home: "/Users/owner",
    pathPrepend: ["/svc/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  });
});

test("the Gateway environment carries the wrapper and never the token", () => {
  const paths = { home: "/h", tmp: "/t", state: "/s", config: "/c" };
  const parent = { OPENCLAW_GATEWAY_TOKEN: "leak", SHELL: "/bin/zsh", PATH: "/x" };
  const env = runtimeEnvironment(paths, "/node/bin/node", parent, { shell: "/w/exec" });
  assert.equal(env.SHELL, "/w/exec");
  assert.equal(env.HOME, "/h");
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.ok(!JSON.stringify(env).includes("leak"));
  assert.equal(runtimeEnvironment(paths, "/node/bin/node", parent).SHELL, undefined);
});

async function startWith(t, shellOwner) {
  const dataDir = tempDir(t, "assistant-shell-start-");
  const spawned = [],
    clients = [];
  const supervisor = new RuntimeSupervisor({
    dataDir,
    install: async () => ({ nodePath: "/rt/node/bin/node", entryPath: "/rt/e.mjs" }),
    spawn: (command, args, options) => {
      spawned.push(options);
      return Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill() {
          this.exitCode = 0;
          this.emit("exit", 0);
        },
      });
    },
    clientFactory: (options) =>
      Object.assign(new EventEmitter(), {
        options: clients.push(options) && options,
        ready: false,
        async connect() {
          this.ready = true;
        },
        close() {
          this.ready = false;
        },
      }),
    shellOwner: () => shellOwner(dataDir),
  });
  t.after(() => supervisor.close());
  const agent = profile("approval");
  supervisor.teamConfiguration = async () => teams([agent]);
  const paths = runtimePaths(dataDir);
  const { gateway: _gateway, ...existing } = seeded([agent]);
  fs.writeFileSync(paths.config, JSON.stringify(existing));
  await supervisor.start();
  return {
    supervisor,
    paths,
    clients,
    env: spawned[0].env,
    config: readJSON(paths.config),
  };
}

test("a start writes the wrapper, compiles the owner PATH and keeps the token out", async (t) => {
  let ownerHome;
  const { supervisor, paths, clients, env, config } = await startWith(t, (dataDir) => {
    ownerHome = path.join(dataDir, "owner-home");
    fs.mkdirSync(ownerHome);
    return { home: ownerHome, pathPrepend: ["/owner/bin"] };
  });
  assert.equal(env.SHELL, path.join(paths.root, "exec-shell", "sh"));
  assert.equal(env.HOME, paths.home);
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.match(fs.readFileSync(env.SHELL, "utf8"), new RegExp(`HOME='${ownerHome}'`));
  assert.equal(fs.statSync(env.SHELL).mode & 0o777, 0o500);
  assert.ok(config.gateway.auth.token);
  assert.ok(!JSON.stringify(env).includes(config.gateway.auth.token));
  assert.deepEqual(config.agents.entries["ap-approval"].tools.exec, {
    mode: "ask",
    strictInlineEval: true,
    pathPrepend: ["/owner/bin"],
  });
  assert.deepEqual(config.tools.allow.slice(-2), ["exec", "process"]);
  assert.deepEqual(supervisor.shell, { pathPrepend: ["/owner/bin"] });
  // The main client is the only one that answers exec approvals.
  assert.deepEqual(
    clients.map((c) => c.caps),
    [["exec-approvals"]],
  );
});

test("an unresolvable owner starts the Gateway without the wrapper", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (message) => logged.push(message));
  for (const owner of [
    () => {
      throw Error("no passwd entry for uid 4242");
    },
    () => ({ home: "relative/home", pathPrepend: ["/owner/bin"] }),
  ]) {
    const { supervisor, paths, env, config } = await startWith(t, owner);
    assert.equal(supervisor.status().availability, "ready");
    assert.equal(env.SHELL, undefined);
    assert.equal(fs.existsSync(path.join(paths.root, "exec-shell", "sh")), false);
    // Shell agents keep their level, only without the owner's environment.
    assert.deepEqual(config.agents.entries["ap-approval"].tools.exec, {
      mode: "ask",
      strictInlineEval: true,
    });
    assert.deepEqual(supervisor.shell, { pathPrepend: [] });
  }
  assert.equal(logged.length, 2);
  assert.match(logged[0], /without the owner's environment: no passwd entry/);
  assert.match(logged[1], /not an absolute path/);
});
