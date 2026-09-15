import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAgentBusInterpreter } from "../../server/features/agentbus/agentbus-launch-identity.js";
import { resolveAgentBusProcess } from "../../server/features/agentbus/agentbus-process.js";

const script = `
const { spawn } = require('node:child_process');
const depth = Number(process.argv[1]);
process.on('message', ({title}) => { process.title = title; process.send({title}); });
if (depth) {
 const child = spawn(process.execPath, ['-e', ${JSON.stringify("SCRIPT")}, String(depth - 1)], {stdio:['ignore','ignore','ignore','ipc']});
 child.on('message', ids => process.send([process.pid, ...ids]));
} else process.send([process.pid]);
setInterval(() => {}, 1000);
`;

async function fixture(t, depth = 1, tool = "codex") {
  // Recursive source substitution avoids writing fixture programs into the checkout.
  const source = script.replace(JSON.stringify("SCRIPT"), "process.env.TREE_SCRIPT");
  const child = spawn(process.execPath, ["-e", source, String(depth)], {
    env: { ...process.env, TREE_SCRIPT: source },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const [ids] = await once(child, "message");
  t.after(async () => {
    const exited = once(child, "exit");
    for (const pid of ids.toReversed()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await exited;
  });
  const session = { id: "owned-session", status: "running", tool };
  const launch = { id: session.id, tool, command: process.execPath, cwd: process.cwd() };
  const sessions = {
    target(id) {
      assert.equal(id, session.id);
      return "isolated-pane";
    },
    async tmux(args) {
      assert.deepEqual(args, [
        "display-message",
        "-p",
        "-t",
        "isolated-pane:0.0",
        "#{pane_pid}",
      ]);
      return String(ids[0]);
    },
  };
  const setTitle = async (title) => {
    const changed = once(child, "message");
    child.send({ title });
    assert.deepEqual((await changed)[0], { title });
  };
  return { session, launch, sessions, claimedPid: ids.at(-1), ids, setTitle };
}

test("hook claim resolves to the host-authorized runtime and pins its start", async (t) => {
  const f = await fixture(t);
  const result = await resolveAgentBusProcess(f);
  assert.equal(result.pid, f.ids[0]);
  assert.equal(typeof result.pidStart, "string");
  assert.ok(result.pidStart.length > 5);
});

test("OpenCode requires the native runtime itself, not its plugin child", async (t) => {
  const f = await fixture(t, 1, "opencode");
  assert.equal(
    (await resolveAgentBusProcess({ ...f, claimedPid: f.ids[0] })).pid,
    f.ids[0],
  );
  await assert.rejects(resolveAgentBusProcess(f));
});

test("foreign, malformed, vanished, and missing claims fail closed", async (t) => {
  const f = await fixture(t);
  for (const claimedPid of [process.pid, 2147483647, "123", 0, -1, undefined]) {
    await assert.rejects(resolveAgentBusProcess({ ...f, claimedPid }));
  }
});

test("nested runtimes cannot register as the outer AgentPier session", async (t) => {
  const f = await fixture(t, 2);
  await assert.rejects(resolveAgentBusProcess(f));
});

test("a node hook cannot impersonate a different launched native executable", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    resolveAgentBusProcess({
      ...f,
      launch: { ...f.launch, command: "/usr/local/bin/codex" },
    }),
  );
});

test("stopped sessions and mismatched launch identities fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    resolveAgentBusProcess({ ...f, session: { ...f.session, status: "stopped" } }),
  );
  await assert.rejects(
    resolveAgentBusProcess({ ...f, launch: { ...f.launch, id: "foreign" } }),
  );
});

test("unavailable or changing authoritative panes cannot authenticate", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    resolveAgentBusProcess({
      ...f,
      sessions: {
        ...f.sessions,
        tmux: async () => {
          throw new Error("unavailable");
        },
      },
    }),
  );
  let calls = 0;
  await assert.rejects(
    resolveAgentBusProcess({
      ...f,
      sessions: {
        ...f.sessions,
        tmux: async () => String(++calls === 1 ? f.ids[0] : process.pid),
      },
    }),
  );
});

test("a hook that exits during authentication cannot leave a stale binding", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const sessions = {
    ...f.sessions,
    async tmux(args) {
      if (++calls === 2) {
        process.kill(f.claimedPid, "SIGKILL");
        // Wait until the OS has reaped the hook, without touching user processes.
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(f.claimedPid, 0);
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      return f.sessions.tmux(args);
    },
  };
  await assert.rejects(resolveAgentBusProcess({ ...f, sessions }));
});

test(
  "Linux runtime executable survives mutable process titles across snapshots",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await fixture(t);
    await f.setTitle("MainThread");
    let calls = 0;
    const sessions = {
      ...f.sessions,
      async tmux(args) {
        if (++calls === 2) await f.setTitle("worker-renamed");
        return f.sessions.tmux(args);
      },
    };
    const result = await resolveAgentBusProcess({ ...f, sessions });
    assert.equal(result.pid, f.ids[0]);
    assert.equal(readFileSync(`/proc/${f.ids[0]}/comm`, "utf8").trim(), "worker-renamed");
  },
);

test(
  "Linux process titles cannot impersonate the launched CLI executable",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await fixture(t);
    await f.setTitle("codex");
    assert.equal(readFileSync(`/proc/${f.ids[0]}/comm`, "utf8").trim(), "codex");
    await assert.rejects(
      resolveAgentBusProcess({
        ...f,
        launch: { ...f.launch, command: "/usr/local/bin/codex" },
      }),
    );
  },
);

async function scriptFixture(
  t,
  { nested = false, unrelated = false, suffix = false } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentbus npm claude "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "installed cli.cjs");
  const command = path.join(dir, "claude");
  const hook = "process.send([process.pid]); setInterval(() => {}, 1000)";
  writeFileSync(
    file,
    `#!/usr/bin/env node
const {spawn} = require('node:child_process');
const args = ${nested} && process.argv[2] !== 'nested'
  ? [__filename, 'nested'] : ['-e', ${JSON.stringify(hook)}];
const child = spawn(process.execPath, args, {stdio:['ignore','ignore','ignore','ipc']});
child.on('message', ids => process.send([process.pid,...ids]));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(file, 0o700);
  symlinkSync(file, command);
  const impostor = `${command} extra`;
  if (suffix) {
    writeFileSync(impostor, readFileSync(file));
    chmodSync(impostor, 0o700);
  }
  const source = `const {spawn}=require('node:child_process');
const child=spawn(${JSON.stringify(unrelated ? process.execPath : suffix ? impostor : command)}, ${unrelated ? `['-e', ${JSON.stringify(hook)}]` : "[]"}, {stdio:['ignore','ignore','ignore','ipc']});
child.on('message', ids=>process.send([process.pid,...ids])); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", source], {
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const [ids] = await once(child, "message");
  t.after(async () => {
    const exited = once(child, "exit");
    for (const pid of ids.toReversed()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await exited;
  });
  return {
    session: { id: "npm-session", status: "running", tool: "claude" },
    launch: {
      id: "npm-session",
      tool: "claude",
      command,
      runtimeInterpreter: resolveAgentBusInterpreter(command, {
        PATH: path.dirname(process.execPath),
      }),
    },
    sessions: { target: () => "isolated", tmux: async () => String(ids[0]) },
    claimedPid: ids.at(-1),
    ids,
  };
}

test("npm Claude symlink and space paths resolve its script interpreter, excluding wrapper and hook", async (t) => {
  const f = await scriptFixture(t);
  assert.equal((await resolveAgentBusProcess(f)).pid, f.ids[1]);
  await assert.rejects(resolveAgentBusProcess({ ...f, claimedPid: f.ids[1] }));
});

test("an unrelated Node process does not match the authorized Claude script", async (t) => {
  const f = await scriptFixture(t, { unrelated: true });
  await assert.rejects(resolveAgentBusProcess(f));
});

test("a nested Claude script cannot replace the launched runtime", async (t) => {
  const f = await scriptFixture(t, { nested: true });
  await assert.rejects(resolveAgentBusProcess(f));
});

test("a script path extending the authorized path cannot impersonate Claude", async (t) => {
  const f = await scriptFixture(t, { suffix: true });
  await assert.rejects(resolveAgentBusProcess(f));
});

test("the authorized script requires the captured interpreter executable", async (t) => {
  const f = await scriptFixture(t);
  await assert.rejects(
    resolveAgentBusProcess({
      ...f,
      launch: { ...f.launch, runtimeInterpreter: "/bin/sh" },
    }),
  );
});

test("script launch identity resolves only executable Node shebangs from trusted PATH", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentbus-shebang-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const command = path.join(dir, "claude");
  writeFileSync(command, "#!/usr/bin/env node\n");
  assert.equal(resolveAgentBusInterpreter(command, { PATH: dir }), null);
  assert.equal(resolveAgentBusInterpreter(command, { PATH: "." }), null);
  symlinkSync(process.execPath, path.join(dir, "node"));
  assert.ok(resolveAgentBusInterpreter(command, { PATH: dir }));
  writeFileSync(command, "#!/bin/sh\n");
  assert.equal(resolveAgentBusInterpreter(command, { PATH: dir }), null);
  writeFileSync(command, `#!${process.execPath}\n`);
  assert.ok(resolveAgentBusInterpreter(command));
  writeFileSync(command, "#!/usr/bin/env node --eval\n");
  assert.equal(resolveAgentBusInterpreter(command, { PATH: dir }), null);
});
