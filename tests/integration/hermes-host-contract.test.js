import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hermesFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { createHermesAgentHost } from "../../server/features/assistants/runtimes/hermes/hermes-host.js";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { hermesEnvironment } from "../../server/features/assistants/runtimes/hermes/hermes-environment.js";

// Native Hermes contract: AGENTPIER_HERMES_CONTRACT_RUNTIME names an installation
// that scripts/provision-hermes-contracts.mjs made from the pinned manifest.
const runtime = process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME;
const skip = runtime ? false : "AGENTPIER_HERMES_CONTRACT_RUNTIME is not set";

/** Every process whose command runs the installation: [{ pid, ppid, pgid, command }]. */
function hermesProcesses() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match && match[4].includes(runtime))
    .map(([, pid, ppid, pgid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      command,
    }));
}

/** A JSON-RPC call over the host's channel; events are collected in `events`. */
function client(host) {
  const transport = host.transport();
  const events = [];
  const pending = new Map();
  const methods = new Map();
  const method = (key) => methods.get(key);
  let id = 0;
  transport.onMessage((frame) => {
    if (frame.id !== undefined && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error)
        reject(
          Object.assign(Error(`${method(frame.id)}: ${frame.error.message}`), {
            code: frame.error.code,
            data: frame.error.data,
          }),
        );
      else resolve(frame.result);
    } else if (frame.method === "event") events.push(frame.params);
  });
  return {
    events,
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        methods.set(id, method);
        transport.send({ jsonrpc: "2.0", id, method, params });
      }),
  };
}

test(
  "a Hermes agent's gateway and RPC bridge share its home, never self-spawn and stop cleanly",
  { skip, timeout: 600000 },
  async (t) => {
    assert.deepEqual(hermesProcesses(), [], "no Hermes of this installation runs before");
    const model = await hermesFakeModel(t);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-host-contract-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const record = {
      version: "contract",
      directory: runtime,
      ...hermesExecutables(runtime),
    };
    record.pythonPath = record.python;
    record.hermesPath = record.hermes;
    const { supervisor, host } = createHermesAgentHost({
      dataDir,
      agentId: "contract-agent",
      runtime: async () => record,
      environment: { ...process.env, AGENTPIER_CONTRACT_SECRET: "never-in-agent" },
      readyTimeoutMs: 180000,
    });
    t.after(() => supervisor.stop());
    const agent = supervisor.agentPaths();
    fs.writeFileSync(
      path.join(agent.hermesHome, "config.yaml"),
      [
        "model:",
        "  provider: custom",
        "  default: fake-1",
        `  base_url: ${model.url}`,
        "  api_key: contract-key",
        "  api_mode: chat_completions",
        "terminal:",
        "  backend: local",
        `  cwd: ${agent.workspace}`,
        "compression:",
        "  enabled: false",
        "onboarding:",
        '  profile_build: "off"',
        "",
      ].join("\n"),
    );

    await host.start();
    assert.equal(host.status().availability, "ready");
    const [gateway, bridge] = supervisor.pids();
    // Both processes lead their own groups; every process of the installation is
    // inside one of them: nothing detached, nothing started by Hermes itself.
    const running = hermesProcesses();
    assert.ok(running.some(({ pid }) => pid === gateway));
    assert.ok(running.some(({ pid }) => pid === bridge));
    for (const entry of running)
      assert.ok([gateway, bridge].includes(entry.pgid), JSON.stringify(entry));
    // The gateway owns the home; the RPC bridge is attached to it.
    const lock = JSON.parse(
      fs.readFileSync(path.join(agent.hermesHome, "gateway.lock"), "utf8"),
    );
    assert.equal(lock.pid, gateway);

    const rpc = client(host);
    await rpc.call("client.capabilities", { server_requests: true });
    const session = await rpc.call("session.create", {});
    // The gateway's own session store admits a turn by its idempotency key.
    await rpc.call("prompt.submit", {
      session_id: session.session_id,
      text: "hello contract",
      submission_id: "contract-turn-1",
    });
    await eventually(
      () => rpc.events.some((event) => event.type === "message.complete"),
      120000,
      "message.complete",
    );
    const complete = rpc.events.find((event) => event.type === "message.complete");
    assert.match(JSON.stringify(complete), /ECHO: hello contract/);
    assert.ok(model.requests.some((url) => url.includes("/chat/completions")));

    // What every Hermes client (`hermes cron run`, `hermes chat`, …) does first: it
    // finds the running owner and attaches; no second gateway is started.
    const env = hermesEnvironment({ agent, runtime: record });
    assert.equal(env.AGENTPIER_CONTRACT_SECRET, undefined);
    const ensured = execFileSync(
      record.pythonPath,
      [
        "-I",
        "-c",
        "import os, sys; from pathlib import Path; " +
          "from hermes_cli.gateway_runtime import ensure_gateway_runtime; " +
          "r = ensure_gateway_runtime(Path(os.environ['HERMES_HOME']), timeout=30, idle_exit=True); " +
          "os.write(1, r.state.encode())",
      ],
      { env, cwd: agent.workspace, encoding: "utf8" },
    );
    assert.equal(ensured, "ready");
    for (const entry of hermesProcesses())
      assert.ok([gateway, bridge].includes(entry.pgid), JSON.stringify(entry));

    // A crash of the gateway restarts the whole set.
    const generation = host.generation();
    process.kill(gateway, "SIGKILL");
    await eventually(
      () => host.ready() && host.generation() !== generation,
      240000,
      "restart after a crash",
    );
    assert.equal(
      hermesProcesses().some(({ pid }) => pid === bridge),
      false,
    );
    // An owner's restart works the same way, and the new channel answers.
    const crashed = host.generation();
    await host.restart();
    assert.notEqual(host.generation(), crashed);
    const again = client(host);
    assert.ok(await again.call("session.list", {}));

    const pointer = path.join(agent.hermesHome, "gateway.sock.path");
    const socket = fs.existsSync(pointer)
      ? fs.readFileSync(pointer, "utf8").trim()
      : null;
    await host.stop();
    assert.equal(host.status().availability, "disabled");
    // No control socket folder of the agent stays behind in the temporary directory.
    if (socket) assert.equal(fs.existsSync(path.dirname(socket)), false);
    await host.assertStopped();
    await eventually(
      () => hermesProcesses().length === 0,
      15000,
      "no Hermes process left",
    );
  },
);
