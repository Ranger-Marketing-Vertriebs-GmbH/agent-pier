import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { scripted, settle } from "../helpers/hermes-scripted.js";
import {
  hermesRoutineApproval,
  routineApprovalRefusals,
} from "../../server/features/assistants/hermes-routine-approvals.js";
import { toolPolicy } from "../../server/features/assistants/bridge-tool-policies.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { guardFiles } from "../../server/features/assistants/runtimes/hermes/hermes-config/guard-plugin.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";

const runKey = "agent:ap-a1:hermes:cron:job1:cron_job1_20261102_090000";

test("a question AgentPier raises waits for the owner's answer like Hermes's own", async () => {
  const { approvals, events } = await scripted(() => ({}));
  const seen = [];
  events.subscribe((e) => seen.push(e));
  const asked = approvals.ask({
    sessionKey: runKey,
    command: "rm -rf build",
    description: "recursive delete",
  });
  await settle();
  const requested = seen.find((e) => e.kind === "approval.requested");
  assert.equal(requested.event, "exec.approval.requested");
  assert.equal(requested.sessionKey, runKey);
  const { payload } = requested;
  assert.equal(payload.expiresAtMs - payload.createdAtMs, 300000);
  assert.equal(payload.request.command, "rm -rf build");
  assert.equal(payload.request.warningText, "recursive delete");
  assert.deepEqual(payload.request.allowedDecisions, ["allow-once", "deny"]);
  assert.equal(payload.settle, undefined);
  const [listed] = await approvals.list();
  assert.equal(listed.id, payload.id);
  assert.equal(listed.timer, undefined);
  await assert.rejects(approvals.resolve({ id: payload.id, decision: "allow-session" }));
  assert.deepEqual(await approvals.resolve({ id: payload.id, decision: "allow-once" }), {
    ok: true,
    id: payload.id,
    decision: "allow-once",
  });
  assert.equal(await asked, "allow-once");
  assert.deepEqual(await approvals.list(), []);
  const ended = (await approvals.history()).items.find((i) => i.id === payload.id);
  assert.equal(ended.status, "allowed");
  assert.ok(seen.some((e) => e.kind === "approval.resolved"));
  // A denial reaches the guard as a denial.
  const denied = approvals.ask({ sessionKey: runKey, command: "rm -rf dist" });
  await settle();
  const [second] = await approvals.list();
  await approvals.resolve({ id: second.id, decision: "deny" });
  assert.equal(await denied, "deny");
});

test("an unanswered question expires, and a closed connection answers none", async () => {
  const { approvals, client } = await scripted(() => ({}));
  // The queue's own timer never holds the process open.
  const alive = setTimeout(() => {}, 1000);
  const expired = approvals.ask({
    sessionKey: runKey,
    command: "rm -rf a",
    timeoutMs: 20,
  });
  assert.equal(await expired, null);
  const [entry] = (await approvals.history()).items;
  assert.equal(entry.status, "expired");
  const open = approvals.ask({ sessionKey: runKey, command: "rm -rf b" });
  await settle();
  client.emit("disconnected");
  assert.equal(await open, null);
  clearTimeout(alive);
});

// A bridge whose agent `a1` runs on Hermes, its routine run of job1 under way.
function bridgeFor({ shell = "approval", origin = true, answer = "allow-once" } = {}) {
  const asked = [];
  const agent = {
    id: "a1",
    runtimeAgentId: "ap-a1",
    runtime: "hermes",
    shell,
  };
  const runtime = {
    host: { ready: () => true },
    approvals: {
      ask: async (input) => {
        asked.push(input);
        return answer;
      },
    },
  };
  const supervisor = {};
  attachHermesFleet(supervisor, { runtimeOf: () => runtime });
  return {
    asked,
    bridge: {
      closed: false,
      agentOf: (id) => (id === "ap-a1" ? agent : null),
      assistants: {
        runtime: supervisor,
        routines: {
          runOrigin: () => (origin ? { binding: {}, conversation: { id: "c1" } } : null),
          hooks: { runOrigin: () => null },
        },
      },
    },
  };
}

test("the bridge asks only for a running routine's run of a Hermes agent with a shell", async () => {
  const input = {
    agentId: "ap-a1",
    sessionKey: runKey,
    command: "rm -rf build",
    description: "recursive delete",
    kind: "command",
  };
  const allowed = bridgeFor();
  assert.deepEqual(await toolPolicy(allowed.bridge, "/hermes-approval", input), {
    allow: true,
  });
  assert.deepEqual(allowed.asked, [
    { sessionKey: runKey, command: "rm -rf build", description: "recursive delete" },
  ]);
  assert.deepEqual(
    await hermesRoutineApproval(bridgeFor({ answer: "deny" }).bridge, input),
    {
      allow: false,
      message: routineApprovalRefusals.denied,
    },
  );
  for (const options of [{ answer: null }, { origin: false }, { shell: "off" }]) {
    const { bridge, asked } = bridgeFor(options);
    assert.deepEqual(await hermesRoutineApproval(bridge, input), {
      allow: false,
      message: routineApprovalRefusals.unanswered,
    });
    if (options.answer === undefined) assert.deepEqual(asked, []);
  }
  for (const sessionKey of [
    "agent:ap-a1:hermes:chat-1",
    "agent:ap-a2:hermes:cron:job1:s1",
    "agent:ap-a1:hermes:cron:job1",
  ]) {
    const { bridge, asked } = bridgeFor();
    const answer = await hermesRoutineApproval(bridge, { ...input, sessionKey });
    assert.equal(answer.allow, false, sessionKey);
    assert.deepEqual(asked, []);
  }
  const { bridge } = bridgeFor();
  await assert.rejects(hermesRoutineApproval(bridge, { ...input, kind: "other" }));
  await assert.rejects(hermesRoutineApproval(bridge, { ...input, extra: 1 }));
  assert.deepEqual(
    await toolPolicy({ ...bridge, closed: true }, "/hermes-approval", input),
    {
      allow: false,
    },
  );
});

test("an approval-level home asks the owner in routine runs only with the team bridge", () => {
  const profile = {
    id: "a1",
    runtimeAgentId: "ap-a1",
    revision: 1,
    shell: "approval",
  };
  const connection = { url: "http://127.0.0.1:4100", token: "t" };
  const home = compileHome(desiredAgent(profile), { connection });
  const config = readHermesConfig(home.files["config.yaml"]);
  assert.equal(config.approvals.mode, "manual");
  assert.equal(config.approvals.cron_mode, "approve");
  assert.equal(config.plugins.hook_callback_timeout, 330);
  assert.ok(config.plugins.enabled.includes("agentpier-guard"));
  assert.deepEqual(JSON.parse(home.files["plugins/agentpier-guard/guard.json"]), {
    everyCommand: false,
    cronAsks: true,
  });
  // Without the bridge Hermes keeps its own deny; full access asks nobody.
  for (const other of [
    compileHome(desiredAgent(profile), {}),
    compileHome(desiredAgent({ ...profile, shell: "full" }), {
      connection,
    }),
  ]) {
    const c = readHermesConfig(other.files["config.yaml"]);
    assert.equal(c.approvals.cron_mode, undefined);
    assert.equal(c.plugins.hook_callback_timeout, undefined);
    assert.equal(c.plugins.enabled.includes("agentpier-guard"), false);
  }
});

const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

// Runs the guard's hook once in a plain Python (Hermes's modules absent: the guard
// falls back to asking about every command it would check).
async function runHook(dir, call, env = {}) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
print(json.dumps(guard._guard(**json.loads(sys.argv[2]))))
`;
  // Asynchronous: the bridge answering it runs in this process.
  const { stdout } = await promisify(execFile)(
    python,
    [
      "-I",
      "-c",
      script,
      path.join(dir, "agentpier-guard", "__init__.py"),
      JSON.stringify(call),
    ],
    { env: { PATH: process.env.PATH, ...env }, timeout: 20000 },
  );
  return JSON.parse(stdout);
}

test(
  "the guard's hook asks the bridge in a routine run and fails closed",
  { skip: !python && "python3 is not installed" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const plugins = path.join(root, "plugins");
    for (const [file, text] of Object.entries(guardFiles({ cronAsks: true }))) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    const bodies = [];
    let answer = { allow: true };
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        bodies.push({
          url: req.url,
          auth: req.headers.authorization,
          body: JSON.parse(data),
        });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const call = {
      tool_name: "terminal",
      args: { command: "rm -rf build" },
      session_id: "cron_job1_20261102_090000",
      task_id: "cron:job1:exec1",
    };
    // No bridge file: nothing to ask, so the call is blocked.
    const blocked = await runHook(plugins, call, { HERMES_CRON_SESSION: "1" });
    assert.equal(blocked.action, "block");
    fs.mkdirSync(path.join(plugins, "agentpier-team"));
    fs.writeFileSync(
      path.join(plugins, "agentpier-team", "bridge.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}`,
        token: "tok",
        agentId: "ap-a1",
      }),
    );
    assert.equal(await runHook(plugins, call, { HERMES_CRON_SESSION: "1" }), null);
    assert.deepEqual(bodies.at(-1), {
      url: "/hermes-approval",
      auth: "Bearer tok",
      body: {
        agentId: "ap-a1",
        sessionKey: runKey,
        command: "rm -rf build",
        description: "unrecognised command",
        kind: "command",
      },
    });
    answer = { allow: false, message: "BLOCKED: denied" };
    assert.deepEqual(await runHook(plugins, call, { HERMES_CRON_SESSION: "1" }), {
      action: "block",
      message: "BLOCKED: denied",
    });
    // execute_code asks as code; outside a routine run nothing is asked here.
    await runHook(
      plugins,
      { ...call, tool_name: "execute_code", args: { code: "print(1)" } },
      { HERMES_CRON_SESSION: "1" },
    );
    assert.equal(bodies.at(-1).body.kind, "code");
    const before = bodies.length;
    assert.equal(await runHook(plugins, call), null);
    assert.equal(bodies.length, before);
  },
);
