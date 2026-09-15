import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
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
