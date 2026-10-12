import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually, shellGateway } from "../helpers/assistant-shell-gateway.js";

// What `sessions.abort` ends of a shell agent's commands (docs/assistant-shell-
// qualification.md (g)). Every command writes its own pid into the test directory;
// a process the test started that is still alive at the end is killed by that pid.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: 300000,
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid) =>
  !!(await eventually(() => !alive(pid), { tries: 50, ms: 100 }));

async function gateway(t, prefix) {
  const gw = await shellGateway(t, installed, { prefix });
  const started = [];
  t.after(() => {
    for (const pid of started) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  let n = 0;
  // Starts `sleep` through exec in a new turn; resolves once its pid is known.
  gw.sleeper = async (args = {}) => {
    const file = path.join(gw.dataDir, `sleeper-${++n}.pid`);
    const run = await gw.send(`sleep-${n}`, {
      command: `echo $$ > ${file}; exec sleep 300`,
      ...args,
    });
    const pid = Number(
      await eventually(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()),
    );
    assert.ok(pid > 0, "the command started");
    started.push(pid);
    return { run, pid };
  };
  gw.abort = (run) =>
    gw.client.call("sessions.abort", { key: run.session.key, runId: run.runId });
  return gw;
}

test(
  "an abort ends a running foreground exec, but not a background one; a restart ends it on Linux only",
  options,
  async (t) => {
    const gw = await gateway(t, "shell-abort-");
    const tools = ["session_status", "exec", "process"];
    await gw.configure({
      tools: { allow: tools, exec: { mode: "deny" } },
      agents: { entries: { main: { tools: { allow: tools, exec: { mode: "full" } } } } },
    });
    // A background session outlives its turn, the abort of the next one and the
    // session's reset: OpenClaw 2026.9.8 ends it only through the agent's own
    // `process` tool, which no Gateway RPC reaches (tools.invoke answers "Tool not
    // available: process").
    const background = await gw.sleeper({ background: true });
    const settled = await gw.settle(background.run);
    assert.match(settled.result, /Command still running/);
    const foreground = await gw.sleeper();
    await gw.abort(foreground.run);
    assert.ok(await gone(foreground.pid), "the abort kills the foreground command");
    assert.equal(alive(background.pid), true);
    const invoked = await gw.client.call("tools.invoke", {
      name: "process",
      args: { action: "list" },
      sessionKey: background.run.session.key,
    });
    assert.deepEqual([invoked.ok, invoked.error?.code], [false, "not_found"]);
    await gw.client.call("sessions.reset", { key: background.run.session.key });
    await delay(1500);
    assert.equal(alive(background.pid), true, "background exec survives a reset");
    // A Gateway stop waits for background sessions while draining, so AgentPier ends
    // it with SIGKILL after its grace. On Linux OpenClaw spawns exec children through
    // its spawn broker, a separate process that terminates every child it owns once
    // the Gateway disconnects. Elsewhere the Gateway spawns them itself, in their own
    // process group, so they outlive the Gateway.
    await gw.runtime.restart();
    if (process.platform === "linux")
      assert.ok(await gone(background.pid), "a restart ends background exec on Linux");
    else {
      await delay(2000);
      assert.equal(alive(background.pid), true, "background exec survives a restart");
    }
  },
);

test(
  "without the process tool exec cannot background, so an abort ends it",
  options,
  async (t) => {
    const gw = await gateway(t, "shell-abort-noprocess-");
    const tools = ["session_status", "exec"];
    await gw.configure({
      tools: { allow: tools, exec: { mode: "deny" } },
      agents: { entries: { main: { tools: { allow: tools, exec: { mode: "full" } } } } },
    });
    // background: true falls back to running in the turn (processToolAvailabilityRef).
    const { run, pid } = await gw.sleeper({ background: true });
    await delay(1500);
    await gw.abort(run);
    assert.ok(await gone(pid), "the abort kills the command");
  },
);
