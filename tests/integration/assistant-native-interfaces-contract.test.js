import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { GatewayClient } from "../../server/features/assistants/gateway-client.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";

const installed = process.env.AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME",
  timeout: 300000,
};

async function gateway(t, prefix) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => ({
      version: runtimeManifest.version,
      nodePath: path.join(installed, "node/bin/node"),
      entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
    }),
  });
  t.after(async () => {
    try {
      await runtime.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await runtime.start();
  return { runtime, client: runtime.client, dataDir };
}

async function answer(promise) {
  try {
    return { result: await promise };
  } catch (error) {
    return { code: error.code, answered: error.answered === true };
  }
}

test("OpenClaw exposes the native interfaces AgentPier builds on", options, async (t) => {
  const { client } = await gateway(t, "native-interfaces-");

  // The locked core holds on the running Gateway.
  const { config } = await client.call("config.get", {});
  assert.equal(config.gateway.terminal.enabled, false);
  assert.equal(config.gateway.controlUi.enabled, false);

  // The hello advertises the methods and events AgentPier builds on.
  for (const method of [
    "config.get",
    "config.schema",
    "config.schema.lookup",
    "config.patch",
    "channels.pairing.list",
    "channels.pairing.approve",
    "channels.pairing.dismiss",
    "exec.approvals.get",
    "exec.approval.list",
    "exec.approval.get",
    "exec.approval.resolve",
  ])
    assert.equal(client.supports(method), true, method);
  for (const event of ["exec.approval.requested", "exec.approval.resolved"])
    assert.equal(client.features.events.has(event), true, event);
  // web.login.* is deliberately left out of discovery and needs a channel plugin.
  assert.equal(client.supports("web.login.start"), false);
  const login = await answer(client.call("web.login.start", {}));
  t.diagnostic(`web.login.start=${JSON.stringify(login)}`);
  assert.equal(login.answered, true);

  // The schema carries UI hints; a lookup reports how a path reloads.
  const schema = await client.call("config.schema", {});
  assert.equal(typeof schema.schema, "object");
  assert.equal(typeof schema.uiHints, "object");
  assert.equal(schema.version, runtimeManifest.version);
  const hot = await client.call("config.schema.lookup", {
    path: "agents.defaults.timeoutSeconds",
  });
  const cold = await client.call("config.schema.lookup", { path: "gateway.port" });
  t.diagnostic(`lookup hot=${JSON.stringify(hot)}`);
  t.diagnostic(`lookup cold=${JSON.stringify(cold)}`);
  assert.equal(hot.reloadKind, "hot");
  assert.equal(cold.reloadKind, "restart");
  assert.equal(cold.hint.label, "Gateway Port");

  // Shrinking an array needs its exact path in replacePaths.
  const allow = "agents.entries.main.tools.allow";
  const entry = (tools) => ({
    agents: { entries: { main: { tools: { allow: tools } } } },
  });
  await patchConfig(client, () => ({ patch: entry(["session_status", "exec"]) }));
  const unconfirmed = await answer(
    patchConfig(client, () => ({ patch: entry(["session_status"]) })),
  );
  t.diagnostic(`array shrink without replacePaths=${JSON.stringify(unconfirmed)}`);
  assert.equal(unconfirmed.code, "INVALID_REQUEST");
  await patchConfig(client, () => ({
    patch: entry(["session_status"]),
    replacePaths: [allow],
  }));
  const replaced = await client.call("config.get", {});
  assert.deepEqual(replaced.config.agents.entries.main.tools.allow, ["session_status"]);

  // A stale base hash is rejected, and patchConfig reports it as a conflict.
  const stale = await client.call("config.get", {});
  await client.call("config.patch", {
    baseHash: stale.hash,
    raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 601 } } }),
  });
  const rejected = await answer(
    client.call("config.patch", {
      baseHash: stale.hash,
      raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 602 } } }),
    }),
  );
  t.diagnostic(`stale hash=${JSON.stringify(rejected)}`);
  assert.deepEqual(rejected, { code: "INVALID_REQUEST", answered: true });
  // A write landing between patchConfig's read and its patch is a conflict.
  let raced = false;
  const racing = {
    async call(method, params) {
      if (method === "config.patch" && !raced) {
        raced = true;
        const latest = await client.call("config.get", {});
        await client.call("config.patch", {
          baseHash: latest.hash,
          raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 603 } } }),
        });
      }
      return client.call(method, params);
    },
  };
  await assert.rejects(
    patchConfig(racing, () => ({
      patch: { agents: { defaults: { timeoutSeconds: 604 } } },
    })),
    { status: 409 },
  );

  // The pairing queue answers with the scopes AgentPier requests.
  const pairing = await client.call("channels.pairing.list", {});
  t.diagnostic(`pairing=${JSON.stringify(pairing)}`);
  assert.deepEqual(pairing.requests, []);
  assert.ok(Array.isArray(pairing.accounts));
});

test(
  "an exec request in ask mode raises an approval event and a denied command never runs",
  options,
  async (t) => {
    const { client, dataDir } = await gateway(t, "native-exec-");
    const marker = path.join(dataDir, "ran");
    const model = await assistantModelServer({
      tool: { name: "exec", arguments: { command: `touch ${marker}` } },
    });
    t.after(() => model.close());
    // Test-only configuration: exec in ask mode for the default agent on the fake
    // model. It bypasses prepareRuntimeConfig on purpose.
    await patchConfig(client, () => ({
      patch: {
        models: {
          providers: {
            fixture: {
              baseUrl: model.url,
              api: "openai-completions",
              apiKey: "fixture-key",
              models: [
                {
                  id: "fixture-model",
                  name: "Fixture",
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        agents: { defaults: { model: { primary: "fixture/fixture-model" } } },
        tools: { allow: ["session_status", "exec"], exec: { mode: "ask" } },
      },
    }));
    async function run(label) {
      const session = await client.call("sessions.create", { agentId: "main", label });
      const sent = await client.call("sessions.send", {
        key: session.key,
        message: "Run the command.",
        idempotencyKey: label,
      });
      return { session, sent };
    }
    const toolResult = (index) =>
      model.requests
        .flatMap((r) => r.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content))
        .at(index);

    // AgentPier's own client declares the "exec-approvals" cap (AGENTPIER-25), so
    // OpenClaw waits for a decision instead of denying inline; a second client
    // declaring the cap receives the same request.
    const own = [];
    t.after(client.subscribe((frame) => own.push(frame)));
    const approver = new GatewayClient({
      url: client.url,
      token: client.token,
      certPath: client.certPath,
      caps: ["exec-approvals"],
    });
    t.after(() => approver.close());
    await approver.connect();
    const events = [];
    approver.subscribe((frame) => events.push(frame));
    const interactive = await run("interactive");
    let requested;
    for (let i = 0; i < 300 && !requested; i++) {
      requested = events.find((e) => e.event === "exec.approval.requested");
      if (!requested) await delay(200);
    }
    assert.ok(requested, "an approval request arrived");
    assert.ok(
      own.some(
        (e) =>
          e.event === "exec.approval.requested" && e.payload.id === requested.payload.id,
      ),
      "AgentPier's own client received it",
    );
    t.diagnostic(`requested=${JSON.stringify(requested.payload)}`);
    const { id, request } = requested.payload;
    assert.equal(request.sessionKey, interactive.session.key);
    assert.equal(request.runId, interactive.sent.runId);
    assert.deepEqual(request.allowedDecisions, ["allow-once", "allow-always", "deny"]);
    assert.equal(fs.existsSync(marker), false, "nothing runs before a decision");
    const pending = await approver.call("exec.approval.get", { id });
    t.diagnostic(`exec.approval.get=${JSON.stringify(pending)}`);
    assert.equal(pending.id, id);
    assert.deepEqual(
      (await approver.call("exec.approval.list", {})).map((a) => a.id),
      [id],
    );
    const resolved = await approver.call("exec.approval.resolve", {
      id,
      decision: "deny",
    });
    t.diagnostic(`exec.approval.resolve=${JSON.stringify(resolved)}`);
    const settled = await approver.call(
      "agent.wait",
      { runId: interactive.sent.runId, timeoutMs: 45000 },
      { timeoutMs: 50000 },
    );
    assert.equal(settled.status, "ok");
    const outcome = events.find((e) => e.event === "exec.approval.resolved");
    t.diagnostic(`resolved=${JSON.stringify(outcome?.payload)}`);
    assert.equal(outcome?.payload.id, id);
    assert.equal(outcome.payload.decision, "deny");
    assert.match(toolResult(-1), /Exec denied .*user-denied/);
    assert.equal(fs.existsSync(marker), false, "a denied command never runs");
  },
);
