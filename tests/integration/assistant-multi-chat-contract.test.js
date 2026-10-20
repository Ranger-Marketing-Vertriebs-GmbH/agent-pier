import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { deletedTranscripts } from "../../server/features/assistants/chat-removal.js";

// Several chats per agent (AGENTPIER-181) against the pinned runtime: AgentPier makes
// one sessions.create session per chat and relies on what these tests pin.

// Answers every turn at once with the turn's own text, so each transcript names it.
async function echoModelServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(404).end();
    let bytes = "";
    for await (const part of req) bytes += part;
    const input = JSON.parse(bytes);
    const last = input.messages.findLast((m) => m.role === "user");
    const said =
      typeof last?.content === "string"
        ? last.content
        : (last?.content || []).map((c) => c.text || "").join(" ");
    const word = said.match(/\b(alpha|beta|gamma)\b/)?.[1] || "none";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "multi-chat-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    chunk({ content: `Reply ${word}` });
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

const text = (messages) =>
  JSON.stringify(
    (messages || []).map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content || []).map((c) => c.text || "").join(" "),
    ),
  );

// The pinned runtime's own session maintenance (OpenClaw 2026.10.3,
// dist/store-maintenance-*.mjs): `t` archives stale dashboard entries, `u` resolves
// `session.maintenance`.
async function runtimeMaintenance(runtime) {
  const dist = path.join(runtime, "app/node_modules/openclaw/dist");
  const [file] = fs.readdirSync(dist).filter((name) => {
    if (!/^store-maintenance-.+\.mjs$/.test(name)) return false;
    const source = fs.readFileSync(path.join(dist, name), "utf8");
    return (
      source.includes("archiveStaleDashboardEntries as t") &&
      source.includes("resolveMaintenanceConfigFromInput as u")
    );
  });
  const module = await import(pathToFileURL(path.join(dist, file)).href);
  return { archiveDashboard: module.t, resolve: module.u };
}

const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "pinned Gateway keeps several sessions per agent apart",
  { skip: !installed, timeout: contractTimeout(240000) },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(installed, "app/node_modules/openclaw/package.json"),
          "utf8",
        ),
      ).version,
      runtimeManifest.version,
    );
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-multi-chat-"));
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
    const config = new AssistantConfig({
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
    const a = store.createAssistant({
      name: "Chats",
      instructions: "Reply briefly.",
      model: { connectionId: c.id, modelId: "echo-model" },
    });
    await config.apply(a.id);
    const client = runtime.client;
    const create = (label) =>
      client.call("sessions.create", { agentId: a.runtimeAgentId, label });
    const turn = async (key, message) => {
      const sent = await client.call("sessions.send", {
        key,
        message,
        idempotencyKey: crypto.randomUUID(),
      });
      const result = await client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 45000 },
        { timeoutMs: 50000 },
      );
      assert.equal(result.status, "ok", JSON.stringify(result));
    };
    const history = async (key) =>
      (await client.call("chat.history", { sessionKey: key, limit: 50 })).messages;

    const first = await create(`AgentPier ${a.id} chat one`);
    const second = await create(`AgentPier ${a.id} chat two`);
    t.diagnostic(JSON.stringify({ keys: [first.key, second.key] }));

    await t.test(
      "two sessions.create calls for one agent keep independent transcripts",
      async () => {
        assert.notEqual(first.key, second.key);
        await turn(first.key, "Say alpha");
        await turn(second.key, "Say beta");
        const one = text(await history(first.key));
        const two = text(await history(second.key));
        assert.match(one, /alpha/);
        assert.doesNotMatch(one, /beta/);
        assert.match(two, /beta/);
        assert.doesNotMatch(two, /alpha/);
      },
    );

    await t.test("a duplicate label is refused", async () => {
      await assert.rejects(create(`AgentPier ${a.id} chat one`));
    });

    await t.test(
      "sessions.reset keeps the key and starts a fresh history window",
      async () => {
        // Documented only: New chat never uses it (agent-chats.js).
        const reset = await client.call("sessions.reset", { key: second.key });
        assert.equal(reset.key, second.key);
        // The key stays and its history window starts afresh: the chat would lose its
        // visible turns while OpenClaw keeps the earlier rows.
        assert.doesNotMatch(text(await history(second.key)), /beta/);
        const listed = await client.call("sessions.list", { agentId: a.runtimeAgentId });
        assert.ok(listed.sessions.some((s) => s.key === second.key));
      },
    );

    await t.test(
      "the session row reports archived state after 7d of simulated inactivity",
      async () => {
        // OpenClaw's maintenance archives idle dashboard sessions after 7 days, and
        // every sessions.create session is one (`agent:<id>:dashboard:<uuid>`). The
        // compiled configuration turns that trigger off (runtime-config.js), so an
        // AgentPier chat never leaves AgentPier's archive state.
        for (const key of [first.key, second.key])
          assert.match(key, /^agent:[^:]+:dashboard:/, key);
        const compiled = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8"));
        assert.equal(compiled.session?.maintenance?.archiveDashboardAfter, false);
        const listed = await client.call("sessions.list", { agentId: a.runtimeAgentId });
        for (const key of [first.key, second.key]) {
          const row = listed.sessions.find((s) => s.key === key);
          assert.ok(row, key);
          assert.ok(!row.archived && !row.archivedAt, JSON.stringify(row));
        }
        // Eight idle days later the runtime's own maintenance leaves them unarchived.
        const maintenance = await runtimeMaintenance(installed);
        const resolved = maintenance.resolve(compiled.session.maintenance);
        const rows = Object.fromEntries(
          listed.sessions
            .filter((s) => [first.key, second.key].includes(s.key))
            .map((s) => [
              s.key,
              { updatedAt: s.updatedAt, sessionStartedAt: s.updatedAt },
            ]),
        );
        const later = Date.now() + 8 * 24 * 3600 * 1000;
        assert.equal(
          maintenance.archiveDashboard(rows, resolved.archiveDashboardAfterMs, {
            nowMs: later,
            log: false,
          }),
          0,
        );
        // The default would have archived both.
        assert.equal(
          maintenance.archiveDashboard(
            rows,
            maintenance.resolve({}).archiveDashboardAfterMs,
            {
              nowMs: later,
              log: false,
            },
          ),
          2,
        );
      },
    );

    await t.test("a natively archived session takes no turn", async () => {
      // Why AgentPier keeps archive state itself and keeps OpenClaw's idle archiving
      // of its chats off: a session OpenClaw archived refuses new work.
      const scratch = await create(`AgentPier ${a.id} chat scratch`);
      const described = await client.call("sessions.describe", { key: scratch.key });
      await client.call("sessions.patch", {
        key: scratch.key,
        archived: true,
        expectedSessionId: described.session.sessionId,
      });
      let refused = null;
      try {
        await turn(scratch.key, "Say gamma");
      } catch (error) {
        refused = { code: error.code, message: error.message };
      }
      assert.equal(refused?.code, "INVALID_REQUEST", JSON.stringify(refused));
    });

    await t.test("sessions.delete removes the session", async () => {
      const sessionId = (await client.call("sessions.describe", { key: first.key }))
        .session.sessionId;
      const before = deletedTranscripts(runtime.paths.state, a.runtimeAgentId, sessionId);
      assert.deepEqual(before, []);
      await client.call("sessions.delete", { key: first.key, deleteTranscript: true });
      assert.doesNotMatch(text(await history(first.key)), /alpha/);
      const listed = await client.call("sessions.list", { agentId: a.runtimeAgentId });
      assert.ok(!listed.sessions.some((s) => s.key === first.key));
      // The retained archive lands in the agent's sessions folder, where AgentPier
      // finds and removes it (chat-removal.js).
      const archives = deletedTranscripts(
        runtime.paths.state,
        a.runtimeAgentId,
        sessionId,
      );
      t.diagnostic(
        JSON.stringify(archives.map((file) => path.relative(runtime.paths.state, file))),
      );
      assert.equal(archives.length, 1);
      assert.ok(
        archives[0].startsWith(
          path.join(runtime.paths.state, "agents", a.runtimeAgentId, "sessions") +
            path.sep,
        ),
      );
      // The other chat stays.
      const remaining = await client.call("sessions.list", { agentId: a.runtimeAgentId });
      assert.ok(remaining.sessions.some((s) => s.key === second.key));
    });
  },
);
