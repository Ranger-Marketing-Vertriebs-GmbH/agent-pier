import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { compactEndOf } from "../../server/features/assistants/compaction-watch.js";

// AGENTPIER-190: what compaction-watch.js relies on when a summary on request
// outlives its request. A connection that called `sessions.subscribe` sees
// `session.operation` compact start and end for the chat's key before the
// `sessions.compact` answer; the main connection, which never subscribes, sees
// neither; the finished summary is a compaction marker in chat.history.

// Answers every model call (turns and the summary) with a short text.
async function model() {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [
      {
        choices: [
          { index: 0, delta: { content: "## Goal\nNoted." }, finish_reason: null },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 },
      },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "manual", object: "chat.completion.chunk", model: body.model, ...item })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

const packageRoot = process.env.AGENTPIER_ASSISTANT_MEMORY_RUNTIME;
test(
  "pinned runtime: a subscribed connection sees a manual compaction end before its answer",
  { skip: !packageRoot, timeout: contractTimeout(180000) },
  async (t) => {
    const runtimeVersion = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version;
    const dataDir = fs.mkdtempSync(
      path.join(
        process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR || os.tmpdir(),
        "manual-compact-",
      ),
    );
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db);
    const fixtureModel = await model();
    const agent = store.createAssistant({
      name: "Summariser",
      instructions: "Owner instructions.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
    });
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeVersion,
        nodePath: path.join(packageRoot, "node/bin/node"),
        entryPath: path.join(packageRoot, "app/node_modules/openclaw/openclaw.mjs"),
        teamPlugin: provisionTeamPlugin({ paths: runtime.paths, runtimeVersion }),
      }),
    });
    const bridge = new TeamBridge({
      assistants: { store, ledger, runtime },
      generation: () => runtime.generation,
      teams: { store: { context: () => ({ kind: "owner" }) } },
    });
    let watcher = null;
    t.after(async () => {
      watcher?.close();
      await runtime.close();
      await bridge.close();
      await fixtureModel.close();
      store.close();
      if (!process.env.AGENTPIER_KEEP_CONTRACT_DIR)
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    runtime.teamConfiguration = async (installed) => ({
      directory: installed.teamPlugin.directory,
      connection: { ...(await bridge.start()), guardReportMs: 1000 },
      hostMaxConcurrent: 4,
      native: { token: "manual-compact-fixture" },
      profiles: store.listAssistants(),
    });
    await runtime.start();
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      client: runtime.client,
      teamReady: () => bridge.status().ready,
      models: {
        resolve: () => ({
          providerId: "fixture",
          modelRef: "fixture/fixture-model",
          provider: {
            baseUrl: fixtureModel.url,
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
          release() {},
        }),
      },
    });
    config.nativeReady = () => true;
    config.writeGuard = () => bridge.guardLive();
    for (let n = 0; n < 200 && !bridge.guardLive(); n++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.guardLive(), true, "the started Gateway reports its guard");
    await config.apply(agent.id);
    const created = await runtime.client.call("sessions.create", {
      agentId: agent.runtimeAgentId,
      label: "Manual compaction contract",
    });
    for (const text of ["My router lives at 10.0.0.1.", "The DNS server is 10.0.0.53."]) {
      const sent = await runtime.client.call("sessions.send", {
        key: created.key,
        message: text,
        idempotencyKey: crypto.randomUUID(),
      });
      await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
    }
    // The main connection's frames, and the watch's own subscribed connection.
    const mainFrames = [];
    const unsubscribe = runtime.client.subscribe((frame) => mainFrames.push(frame));
    t.after(unsubscribe);
    watcher = runtime.client.sibling();
    await watcher.connect();
    const frames = [];
    watcher.subscribe((frame) => {
      if (frame.event === "session.operation") frames.push({ ...frame, at: Date.now() });
    });
    assert.deepEqual(await watcher.call("sessions.subscribe", {}), { subscribed: true });
    const answer = await runtime.client.call(
      "sessions.compact",
      { key: created.key },
      { timeoutMs: 120000 },
    );
    const answeredAt = Date.now();
    assert.equal(answer.compacted, true, JSON.stringify(answer));
    for (let n = 0; n < 40 && frames.length < 2; n++)
      await new Promise((r) => setTimeout(r, 50));
    const operations = frames.filter((f) => f.payload?.sessionKey === created.key);
    assert.deepEqual(
      operations.map((f) => [f.payload.operation, f.payload.phase]),
      [
        ["compact", "start"],
        ["compact", "end"],
      ],
      JSON.stringify(frames),
    );
    const [start, end] = operations.map((f) => f.payload);
    assert.equal(typeof start.operationId, "string");
    assert.equal(end.operationId, start.operationId);
    assert.equal(end.completed, true);
    assert.equal(typeof end.ts, "number");
    assert.ok(operations[1].at <= answeredAt + 50, "the end comes before the answer");
    assert.equal(compactEndOf(operations[1], created.key), "compacted");
    // The main connection never subscribed and gets no session events.
    assert.equal(
      mainFrames.filter((f) => f.event === "session.operation").length,
      0,
      "the main connection stays unsubscribed",
    );
    // The read-only fallback: a compaction marker in the history.
    const history = await runtime.client.call("chat.history", {
      sessionKey: created.key,
      limit: 20,
    });
    assert.ok(
      history.messages.some(
        (m) => m.__openclaw?.kind === "compaction" && m.__openclaw.id,
      ),
      JSON.stringify(history.messages.map((m) => [m.role, m.__openclaw?.kind])),
    );
  },
);
