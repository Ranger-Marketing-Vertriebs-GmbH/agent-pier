import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import {
  degradedAgents,
  noteRefusal,
  pendingAdmission,
  settledAdmission,
} from "../../server/features/assistants/agent-admission.js";
import { sendRefusal } from "../../server/features/assistants/conversation-turns.js";

// AGENTPIER-238 on the pinned runtime: after an unclean stop (a stale lease) the
// Gateway admits its agent databases in the background once it listens, and a
// configuration change meanwhile supersedes that admission for good. AgentPier's
// writes wait for it, so every agent is admitted; one written to anyway stays
// degraded, its turn is refused before any run, and a restart brings it back.

async function echoModelServer() {
  const server = http.createServer(async (req, res) => {
    let bytes = "";
    for await (const part of req) bytes += part;
    if (req.method !== "POST" || !bytes) return res.writeHead(404).end();
    const input = JSON.parse(bytes);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "agent-admission-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    chunk({ content: "Noted" });
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "config writes wait for the background admission; a superseded agent is refused",
  { skip: !installed, timeout: contractTimeout(420000) },
  async (t) => {
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(installed, "app/node_modules/openclaw/package.json"),
          "utf8",
        ),
      ).version,
      runtimeManifest.version,
    );
    const dataDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "assistant-agent-admission-"),
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const server = await echoModelServer();
    t.after(async () => {
      try {
        await runtime.close();
        store.close();
        await server.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    const connections = new ProviderConnections({ dataDir });
    const models = new AssistantModels({ connections });
    await runtime.start();
    const configFor = () =>
      new AssistantConfig({
        client: runtime.client,
        models,
        store,
        workspaces: runtime.paths.workspaces,
      });
    const c = connections.create({
      providerId: "endpoint",
      name: "echo",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: `${server.origin}/v1`,
        authHeader: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        models: [
          {
            modelId: "echo-model",
            source: "manual",
            contextTokens: 32768,
            outputTokens: 4096,
          },
        ],
      },
    });
    const turn = async (key) => {
      const sent = await runtime.client.call("sessions.send", {
        key,
        message: "Hello",
        idempotencyKey: randomUUID(),
      });
      const result = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 45000 },
        { timeoutMs: 50000 },
      );
      assert.equal(result.status, "ok", JSON.stringify(result));
    };
    // Two agents with a database each: the next unclean start admits them late.
    let config = configFor();
    const agents = [];
    for (const name of ["First", "Second"]) {
      const a = store.createAssistant({
        name,
        instructions: "Reply briefly.",
        model: { connectionId: c.id, modelId: "echo-model" },
      });
      await config.apply(a.id);
      const { key } = await createGatewaySession(runtime.client, {
        agentId: a.runtimeAgentId,
        label: `AgentPier ${a.id} chat`,
      });
      await turn(key);
      agents.push({ ...a, key });
    }
    const roster = async () =>
      (await runtime.client.call("agents.list", {})).agents.filter((a) =>
        agents.some((own) => own.runtimeAgentId === a.id),
      );
    // As the Gateway dies uncleanly; the supervisor starts it again.
    const crash = async () => {
      const before = runtime.client;
      runtime.child.kill("SIGKILL");
      while (!(runtime.client !== before && runtime.client?.ready)) await delay(20);
      const listed = await roster();
      t.diagnostic(JSON.stringify(listed.map((a) => a.admissionRefusal?.code ?? "ok")));
      // The scenario is real: the admission runs after the Gateway answers.
      assert.ok(listed.some((a) => a.admissionRefusal?.code === pendingAdmission));
    };

    // A burst of writes right after the start, as a reconnect's re-apply makes:
    // they wait for the admission, and every agent is admitted.
    await crash();
    config = configFor();
    // Concurrent writers to one base hash conflict (live-patch.js), so the burst is
    // queued at once and runs one write after the other, as AgentPier's writers do.
    for (const n of [21, 22, 23])
      await patchConfig(runtime.client, () => ({
        patch: { agents: { defaults: { maxConcurrent: n } } },
      }));
    for (const a of agents) await config.apply(a.id);
    assert.deepEqual(
      (await roster()).filter((a) => a.status === "degraded"),
      [],
    );
    assert.equal(degradedAgents(runtime.client).size, 0);
    for (const a of agents) await turn(a.key);

    // A write that does not wait supersedes the admission for good.
    await crash();
    const client = runtime.client;
    for (let n = 0; n < 10; n++) {
      const { hash } = await client.call("config.get", {});
      await client.call("config.patch", {
        baseHash: hash,
        raw: JSON.stringify({ agents: { defaults: { maxConcurrent: 30 + n } } }),
      });
      if (!(await roster()).some((a) => a.admissionRefusal?.code === pendingAdmission))
        break;
      await delay(300);
    }
    await settledAdmission(client);
    const refused = agents.filter((a) => degradedAgents(client).has(a.runtimeAgentId));
    t.diagnostic(JSON.stringify({ degraded: refused.length }));
    assert.ok(refused.length > 0);
    // Its turn is a definite refusal before any run, named as such.
    const error = await client
      .call("sessions.send", {
        key: refused[0].key,
        message: "Hello",
        idempotencyKey: randomUUID(),
      })
      .then(
        () => assert.fail("a degraded agent took a turn"),
        (e) => e,
      );
    assert.equal(error.code, "UNAVAILABLE");
    assert.equal(error.retryable, false);
    assert.equal(error.admissionRefusal.agentId, refused[0].runtimeAgentId);
    assert.equal(sendRefusal(error), "degraded");
    assert.equal(noteRefusal(client, error).code, "agent-database-inspection-failed");
    // Its chat cannot subscribe either; the refusal says why.
    const subscribe = await client
      .call("sessions.messages.subscribe", { key: refused[0].key })
      .then(
        () => null,
        (e) => e,
      );
    assert.equal(subscribe?.admissionRefusal?.agentId, refused[0].runtimeAgentId);

    // The offered recovery: restarting the agent service admits it again.
    await runtime.restart();
    while (!(runtime.client !== client && runtime.client?.ready)) await delay(20);
    await settledAdmission(runtime.client);
    assert.equal(degradedAgents(runtime.client).size, 0);
    assert.deepEqual(
      (await roster()).filter((a) => a.status === "degraded"),
      [],
    );
    for (const a of agents) await turn(a.key);
  },
);
