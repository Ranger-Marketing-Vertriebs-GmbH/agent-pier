import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionLifecycle } from "../../server/application/session-lifecycle.js";
import { buildSessionLaunch } from "../../server/features/sessions/session-creation.js";
import {
  prepareSessionSshAgent,
  withAgentEnvironment,
} from "../../server/features/ssh/ssh-agent-launch.js";
import { wrapWithNono } from "../../server/features/nono/nono-launch.js";
import { publicSession } from "../../server/features/sessions/session-public.js";
import * as agents from "../helpers/ssh-session-agents-fixture.js";

const generation = "0b7c2f8e-58bf-467b-b983-95a250cf2c3a";
const token = "0123456789abcdef0123456789abcdef";
const folder = "/data/Application Support/ssh-agents/s1";
const details = {
  folder,
  configPath: `${folder}/ssh_config`,
  binDir: `${folder}/bin`,
  socketPath: `/home/u/.agentpier-ssh/abcd1234/${token}/agent.sock`,
  binaries: { ssh: "/usr/bin/ssh", scp: "/usr/bin/scp" },
  generation,
  grants: [
    { access: "read", path: folder },
    { access: "socket", path: `/home/u/.agentpier-ssh/abcd1234/${token}/agent.sock` },
    { access: "read", path: "/usr/bin/ssh" },
    { access: "read", path: "/usr/bin/scp" },
  ],
};
const sshAgent = { enabled: true, generation, token, binaries: details.binaries };

// A SessionSshAgents stand-in that records what the lifecycle asks of it.
function agentStub(order = []) {
  const calls = { prepare: [], discard: [], sync: [] };
  return {
    calls,
    prepare: async (input) => {
      order.push("sshAgents");
      calls.prepare.push(input);
      return { ...input.launch, sshAgent };
    },
    launchDetails: () => details,
    discard: async (id) => calls.discard.push(id),
    sync: async (session) => {
      order.push("sshAgents.sync");
      calls.sync.push(session.id);
      return "written";
    },
  };
}

function lifecycle({ create, tool = "codex" } = {}) {
  const order = [];
  const created = [];
  const sshAgents = agentStub(order);
  const sshLaunches = [];
  const services = {
    config: { home: "/tmp", dataDir: "/tmp" },
    accounts: {
      verifyEndpointTarget: async () => {},
      command: () => ({ command: "/bin/sh", args: [], env: { PATH: "/usr/bin" } }),
    },
    providerAccess: {
      resolve: () => ({ account: { id: "account", tool, name: "test" } }),
    },
    preferences: { get: () => ({ defaultCwd: "/tmp" }) },
    tools: () => [],
    directory: async (x) => x,
    sessions: {
      list: async () => [],
      create:
        create ??
        (async (options) => {
          created.push(options);
          return { ...options, status: "running" };
        }),
      stop: async () => {},
      remove: async () => {},
    },
    sshSessions: {
      validate: (ids) => ids,
      set: async () => order.push("sshSessions.set"),
      discard: () => {},
    },
    sshIntegration: {
      prepare: async ({ launch }) => {
        order.push("sshIntegration");
        const next = { ...launch, sshTools: { enabled: true } };
        sshLaunches.push(next);
        return next;
      },
      discard: async () => {},
    },
    sessionSecrets: {
      validate: () => [],
      prepare: async ({ launch }) => {
        order.push("sessionSecrets");
        return launch;
      },
      sync: async () => {},
      discard: () => {},
    },
    sshAgents,
  };
  for (const key of [
    "github",
    "agentbus",
    "memoryIntegration",
    "bindings",
    "requests",
    "nonoSandbox",
  ])
    services[key] = {
      prepare: async ({ launch }) => launch,
      discard: async () => {},
    };
  return { order, created, sshAgents, sshLaunches, ...createSessionLifecycle(services) };
}

test("launch prepares the agent after the SSH tools and before secrets", async () => {
  const f = lifecycle();
  await f.launch({}, false, { id: "s1" });
  assert.deepEqual(
    f.order.filter((step) =>
      ["sshIntegration", "sshAgents", "sessionSecrets"].includes(step),
    ),
    ["sshIntegration", "sshAgents", "sessionSecrets"],
  );
  assert.equal(f.sshAgents.calls.prepare[0].launch, f.sshLaunches[0]);
  assert.equal(f.sshAgents.calls.prepare[0].id, "s1");
  // The record keeps the agent; the stored env names its paths.
  assert.deepEqual(f.created[0].sshAgent, sshAgent);
  assert.equal(f.created[0].env.AGENTPIER_SSH_CONFIG, details.configPath);
  assert.equal(f.created[0].env.PATH, `${details.binDir}:/usr/bin`);
});

test("a failed launch discards the agent", async () => {
  const f = lifecycle({
    create: async () => {
      throw new Error("tmux failed");
    },
  });
  await assert.rejects(f.launch({}, false, { id: "s2" }), /tmux failed/);
  assert.deepEqual(f.sshAgents.calls.discard, ["s2"]);
});

test("explicit assignments at launch are synced into the agent after they are saved", async () => {
  const f = lifecycle();
  await f.launch({ sshAccessIds: ["a"] }, false, { id: "s3" });
  assert.deepEqual(f.sshAgents.calls.sync, ["s3"]);
  assert.ok(f.order.indexOf("sshSessions.set") < f.order.indexOf("sshAgents.sync"));
});

test("a launch without an agent service or without an agent is left as prepared", async () => {
  const launch = { command: "/bin/sh", args: [], env: { PATH: "/usr/bin" } };
  assert.equal(await prepareSessionSshAgent(null, { id: "s", launch }), launch);
  const none = { prepare: async ({ launch: given }) => given, launchDetails: () => null };
  assert.equal(await prepareSessionSshAgent(none, { id: "s", launch }), launch);
  // Discarded while it started: the session runs without the agent field.
  const gone = {
    prepare: async () => ({ ...launch, sshAgent }),
    launchDetails: () => null,
  };
  assert.deepEqual(await prepareSessionSshAgent(gone, { id: "s", launch }), launch);
});

test("the agent environment never replaces an inherited agent, Git or rsync command (R1)", () => {
  const launch = { command: "/bin/sh", args: [], env: {} };
  const inherited = { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: "/user/agent.sock" };
  const { env } = withAgentEnvironment(launch, details, { tool: "claude", inherited });
  assert.equal(env.PATH, `${details.binDir}:/usr/bin:/bin`);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.GIT_SSH_COMMAND, `'${details.binDir}/ssh'`);
  assert.equal(env.RSYNC_RSH, `'${details.binDir}/ssh'`);
  assert.equal(env.AGENTPIER_SSH_CONFIG, details.configPath);
  assert.equal(env.AGENTPIER_SSH_AUTH_SOCK, details.socketPath);
  assert.equal(env.AGENTPIER_SSH_AGENT, "1");
  // The launch's own values count as inherited too; its PATH is the base.
  const own = withAgentEnvironment(
    {
      ...launch,
      env: { PATH: "/opt/bin", GIT_SSH_COMMAND: "ssh -i x", RSYNC_RSH: "ssh" },
    },
    details,
    { tool: "claude", inherited: {} },
  ).env;
  assert.equal(own.PATH, `${details.binDir}:/opt/bin`);
  assert.equal(own.GIT_SSH_COMMAND, "ssh -i x");
  assert.equal(own.RSYNC_RSH, "ssh");
  assert.equal(own.SSH_AUTH_SOCK, details.socketPath);
  // Shell sessions get no hint variable, even one carried by the launch.
  const shell = withAgentEnvironment(
    { ...launch, env: { AGENTPIER_SSH_AGENT: "1" } },
    details,
    { tool: "shell", inherited: {} },
  ).env;
  assert.equal(shell.AGENTPIER_SSH_AGENT, undefined);
  assert.equal(shell.PATH, details.binDir);
});

test("absence is judged on the environment the CLI receives (R29)", async (t) => {
  const keys = ["SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "RSYNC_RSH"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  });
  // cleanEnvironment passes the server's agent on, but not its Git or rsync command.
  process.env.SSH_AUTH_SOCK = "/inherited/agent.sock";
  process.env.GIT_SSH_COMMAND = "ssh -i /server/key";
  process.env.RSYNC_RSH = "ssh -i /server/key";
  const launch = await prepareSessionSshAgent(agentStub(), {
    id: "s1",
    account: { tool: "codex" },
    launch: { command: "/bin/sh", args: [], env: {} },
  });
  assert.equal(launch.env.SSH_AUTH_SOCK, undefined);
  assert.equal(launch.env.AGENTPIER_SSH_AUTH_SOCK, details.socketPath);
  assert.equal(launch.env.GIT_SSH_COMMAND, `'${details.binDir}/ssh'`);
  assert.equal(launch.env.RSYNC_RSH, `'${details.binDir}/ssh'`);
  delete process.env.SSH_AUTH_SOCK;
  const unset = await prepareSessionSshAgent(agentStub(), {
    id: "s1",
    account: { tool: "codex" },
    launch: { command: "/bin/sh", args: [], env: {} },
  });
  assert.equal(unset.env.SSH_AUTH_SOCK, details.socketPath);
});

test("GIT_SSH_COMMAND reaches a wrapper whose path has spaces and quotes through sh", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent wiring 'q' "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "ssh"), '#!/bin/sh\necho wrapper "$@"\n', {
    mode: 0o700,
  });
  const { env } = withAgentEnvironment(
    { command: "/bin/sh", args: [], env: {} },
    { ...details, binDir },
    { tool: "codex", inherited: {} },
  );
  // Git runs GIT_SSH_COMMAND through the shell with the arguments appended.
  const output = fs.mkdtempSync(path.join(root, "out-"));
  const result = path.join(output, "result");
  fs.writeFileSync(
    path.join(output, "run.sh"),
    `${env.GIT_SSH_COMMAND} host true > "${result}"\n`,
  );
  execFileSync("/bin/sh", [path.join(output, "run.sh")]);
  assert.equal(fs.readFileSync(result, "utf8"), "wrapper host true\n");
});

test("a sandboxed launch grants the own folder, socket and binaries, nothing wider", async () => {
  const launch = await prepareSessionSshAgent(agentStub(), {
    id: "s1",
    account: { tool: "claude" },
    launch: { command: "/bin/claude", args: [], env: {} },
  });
  const isDirectory = (file) => file === folder;
  const { args } = wrapWithNono({
    launch,
    executable: "/usr/local/bin/nono",
    profile: "claude-code",
    isDirectory,
  });
  const pairs = [];
  for (let index = 0; index < args.indexOf("--"); index += 1)
    if (args[index].startsWith("--") && args[index + 1]?.startsWith("/"))
      pairs.push([args[index], args[index + 1]]);
  assert.deepEqual(
    pairs.filter(([, file]) =>
      [folder, details.socketPath, "/usr/bin/ssh", "/usr/bin/scp"].includes(file),
    ),
    [
      ["--read", folder],
      ["--allow-unix-socket", details.socketPath],
      ["--read-file", "/usr/bin/scp"],
      ["--read-file", "/usr/bin/ssh"],
    ].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
  );
  assert.equal(
    args.some((arg) => /^--allow-unix-socket-(dir|subtree|bind)/.test(arg)),
    false,
  );
  // No grant on a parent of the session folder or the socket folder.
  for (const [, file] of pairs)
    for (const own of [folder, path.dirname(details.socketPath)])
      assert.equal(own.startsWith(`${file}/`), false, `${file} is a parent of ${own}`);
  assert.equal(
    pairs.some(([flag, file]) => flag === "--allow" && file === folder),
    false,
  );
});

test("the session record keeps sshAgent and drops a malformed one", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-agent-record-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = {
    directory,
    file: (id) => path.join(directory, `${id}.json`),
    save: async (session) =>
      fs.writeFileSync(
        path.join(directory, `${session.id}.json`),
        JSON.stringify(session),
      ),
  };
  let count = 0;
  const record = async (value) =>
    (
      await buildSessionLaunch(manager, {
        id: `s${(count += 1)}`,
        name: "Agent",
        tool: "claude",
        accountId: "local-claude",
        cwd: directory,
        command: process.execPath,
        sshAgent: value,
      })
    ).session.sshAgent;
  assert.deepEqual(await record(sshAgent), sshAgent);
  for (const bad of [
    { ...sshAgent, generation: "../x" },
    { ...sshAgent, token: "../x" },
    { ...sshAgent, enabled: false },
    { ...sshAgent, binaries: { ssh: "relative/ssh" } },
    { ...sshAgent, binaries: { scp: "/usr/bin/scp" } },
    { ...sshAgent, binaries: { ssh: "/usr/bin/ssh", git: "/usr/bin/git" } },
    { ...sshAgent, binaries: { ssh: "/usr/bin/ssh\nx" } },
    "agent",
  ])
    assert.equal(await record(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(await record({ ...sshAgent, extra: "dropped" }), sshAgent);
});

test("a real agent's launch and reload: same socket path, a new generation", async (t) => {
  const f = agents.fixture(t);
  const request = agents.input({ id: "reloaded-1" });
  f.ids.push(request.id);
  const first = await prepareSessionSshAgent(f.agents, request);
  assert.equal(first.sshAgent.enabled, true);
  f.save({
    id: request.id,
    tool: "claude",
    accountId: "account-1",
    status: "running",
    sshTools: first.sshTools,
    sshAgent: first.sshAgent,
  });
  const second = await prepareSessionSshAgent(f.agents, { ...request, replace: true });
  assert.notEqual(second.sshAgent.generation, first.sshAgent.generation);
  assert.equal(second.sshAgent.token, first.sshAgent.token);
  assert.equal(second.env.AGENTPIER_SSH_AUTH_SOCK, first.env.AGENTPIER_SSH_AUTH_SOCK);
  assert.equal(fs.statSync(second.env.AGENTPIER_SSH_AUTH_SOCK).isSocket(), true);
  assert.equal(
    second.env.PATH.split(path.delimiter)[0],
    f.agents.launchDetails(request.id).binDir,
  );
});

test("browser responses carry only whether a session has an agent (R30)", () => {
  const record = { id: "s1", name: "S", sshAgent };
  const shown = publicSession(record);
  assert.deepEqual(shown.sshAgent, { enabled: true });
  assert.equal(JSON.stringify(shown).includes(token), false);
  assert.equal(JSON.stringify(shown).includes("/usr/bin/ssh"), false);
  // The record itself keeps everything for the server.
  assert.equal(record.sshAgent.token, token);
  const plain = { id: "s2" };
  assert.equal(publicSession(plain), plain);
});
