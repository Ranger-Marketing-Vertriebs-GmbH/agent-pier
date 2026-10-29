import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceSession } from "../../server/features/sessions/session-replacement.js";
import { withAgentEnvironment } from "../../server/features/ssh/ssh-agent-launch.js";
import {
  fixture,
  hostA,
  identitiesAt,
  input,
  launch,
} from "../helpers/ssh-session-agents-fixture.js";

const generation = "0b7c2f8e-58bf-467b-b983-95a250cf2c3a";
const token = "0123456789abcdef0123456789abcdef";

function available(binary) {
  return spawnSync("/bin/sh", ["-c", `command -v ${binary}`]).status === 0;
}

// A wrapper in a path with a space and a quote that records its arguments and fails,
// so the calling tool gives up right after reaching it.
function recordingWrapper(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent wrapper 'q' "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  const record = path.join(root, "argv");
  fs.writeFileSync(
    path.join(binDir, "ssh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${record.replaceAll("'", "'\\''")}'\nexit 255\n`,
    { mode: 0o700 },
  );
  const { env } = withAgentEnvironment(
    { command: "/bin/sh", args: [], env: {} },
    {
      binDir,
      configPath: path.join(root, "ssh_config"),
      socketPath: path.join(root, "agent.sock"),
      grants: [],
    },
    { tool: "codex", inherited: {} },
  );
  return { env, record, root };
}

const clean = (env) => ({ PATH: process.env.PATH, HOME: os.tmpdir(), ...env });

test("git runs GIT_SSH_COMMAND's wrapper from a quoted path", (t) => {
  if (!available("git")) return t.skip("git is not installed");
  const { env, record } = recordingWrapper(t);
  spawnSync("git", ["ls-remote", "ssh://deploy@proxmox-2/srv/repo.git"], {
    env: clean({ GIT_SSH_COMMAND: env.GIT_SSH_COMMAND, GIT_TERMINAL_PROMPT: "0" }),
    stdio: "ignore",
  });
  const argv = fs.readFileSync(record, "utf8").split("\n");
  assert.ok(argv.includes("proxmox-2") || argv.includes("deploy@proxmox-2"), argv);
});

test("rsync runs RSYNC_RSH's wrapper from a quoted path", (t) => {
  if (!available("rsync")) return t.skip("rsync is not installed");
  const { env, record, root } = recordingWrapper(t);
  spawnSync("rsync", ["proxmox-2:/srv/file", path.join(root, "copy")], {
    env: clean({ RSYNC_RSH: env.RSYNC_RSH }),
    stdio: "ignore",
  });
  const argv = fs.readFileSync(record, "utf8").split("\n");
  assert.ok(argv.includes("proxmox-2"), argv);
});

test("a reload that loses OpenSSH keeps the no-openssh reason while it retires the agent", async (t) => {
  const f = fixture(t);
  const { id, prepared, record } = await launch(f);
  assert.equal(prepared.sshAgent.enabled, true);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-ssh-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const reloaded = await f.agents.prepare({
    ...input({ id, env: { PATH: empty } }),
  });
  assert.equal(reloaded.sshAgent, undefined);
  // The reload lifecycle retires the lingering listener with the reason kept.
  await f.agents.discard(id, { keepReason: true });
  assert.equal(f.agents.launchDetails(id), null);
  assert.deepEqual(f.agents.status(record), {
    state: "unavailable",
    reason: "no-openssh",
    aliases: {},
  });
  // A plain discard (a stop) forgets it.
  await f.agents.discard(id);
  assert.equal(f.agents.status(record).reason, "not-eligible");
});

test("a reloading record whose replacement started authorizes the new generation", async (t) => {
  const f = fixture(t);
  const { id, prepared, record } = await launch(f);
  await f.grants.set(record, [hostA.id]);
  const socketPath = f.agents.launchDetails(id).socketPath;
  const reloading = {
    ...record,
    status: "stopped",
    reload: { state: "reloading", replacementStarted: true },
  };
  f.save(reloading);
  assert.equal((await identitiesAt(socketPath)).length, 1);
  // Not while the reload is only requested, nor after it failed, nor for another
  // generation, nor without an agent in the record.
  for (const other of [
    { ...reloading, reload: { state: "reloading" } },
    { ...reloading, reload: { state: "failed", replacementStarted: true } },
    { ...reloading, sshAgent: { ...prepared.sshAgent, generation } },
    { ...reloading, sshAgent: undefined },
  ]) {
    f.save(other);
    assert.deepEqual(await identitiesAt(socketPath), [], JSON.stringify(other.reload));
  }
});

test("a reload records the new agent before the CLI starts and drops the old one at the stop", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-agent-reload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const id = "agent-reload";
  const file = path.join(directory, `${id}.json`);
  const old = { enabled: true, generation, token, binaries: { ssh: "/usr/bin/ssh" } };
  const next = { ...old, generation: "1b7c2f8e-58bf-467b-b983-95a250cf2c3a" };
  const session = {
    id,
    tool: "claude",
    cwd: directory,
    status: "running",
    accountId: "local-claude",
    reload: { state: "reloading" },
    sshAgent: old,
  };
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  let atPrepare, atStart;
  const manager = {
    directory,
    file: () => file,
    save: async (value) => fs.writeFileSync(file, JSON.stringify(value)),
    metadata: async () => session,
    clients: [],
    pendingTerminalInput: new Map(),
    reconciledStops: new Map(),
    remember: async () => {},
    killSession: async () => {},
    newSessionName: (x) => `tuiui-${x}`,
    tmux: async (args) => {
      if (args[0] === "new-session") atStart = read();
      if (args[0] === "display-message") throw new Error("no server");
    },
  };
  await replaceSession(manager, id, async () => {
    atPrepare = read();
    return { command: process.execPath, args: [], env: {}, sshAgent: next };
  });
  // Between the stop and the new agent no generation in the record matches a listener.
  assert.equal(atPrepare.sshAgent, undefined);
  assert.equal(atPrepare.reload.replacementStarted, true);
  assert.deepEqual(atStart.sshAgent, next);
  assert.deepEqual(read().sshAgent, next);
});

test("written alias files and a discard announce the session for the live topic", async (t) => {
  const f = fixture(t);
  const changed = [];
  f.agents.onChange = (id) => changed.push(id);
  const { id, record } = await launch(f);
  changed.length = 0;
  await f.grants.set(record, [hostA.id]);
  assert.equal(await f.agents.sync(record), "written");
  assert.equal(await f.agents.sync(record), "unchanged");
  assert.deepEqual(changed, [id]);
  f.agents.onChange = () => {
    throw new Error("ignored");
  };
  await f.agents.discard(id);
  f.agents.onChange = (other) => changed.push(other);
  await f.agents.discard(id);
  assert.deepEqual(changed, [id, id]);
});
