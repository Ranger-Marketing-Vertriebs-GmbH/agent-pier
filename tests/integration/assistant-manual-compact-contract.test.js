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
import {
  compactOutcome,
  latestMarker,
  readBaseline,
} from "../../server/features/assistants/compaction-watch.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// AGENTPIER-190: what long-chats.js and compaction-watch.js rely on for a summary
// on request. Its `sessions.compact` answer says how it ended, a repeated one that
// finds nothing left answers `compacted: false` (the outcome "nothing"), and a
// finished summary adds a compaction marker to chat.history with a new id and a
// timestamp from the summary's run: the read-only evidence after a dropped call.

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
  "pinned runtime: a manual compaction answers how it ended and leaves a new marker",
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
    t.after(async () => {
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
    const created = await createGatewaySession(runtime.client, {
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
    const warnings = [];
    const before = await readBaseline(runtime.client, created.key, (what, error) =>
      warnings.push([what, error?.code]),
    );
    assert.deepEqual(warnings, []);
    const since = Date.now();
    const answer = await runtime.client.call(
      "sessions.compact",
      { key: created.key },
      { timeoutMs: 120000 },
    );
    assert.equal(compactOutcome({ result: answer }), "compacted", JSON.stringify(answer));
    const marker = latestMarker(
      await runtime.client.call("chat.history", { sessionKey: created.key, limit: 20 }),
    );
    assert.ok(marker, "the summary leaves a marker");
    assert.notEqual(marker.id, before?.id);
    assert.ok(marker.at >= since - 1000, JSON.stringify({ marker, since }));
    // Nothing left to summarise: an answer, not an error.
    const again = await runtime.client.call(
      "sessions.compact",
      { key: created.key },
      { timeoutMs: 120000 },
    );
    assert.equal(compactOutcome({ result: again }), "nothing", JSON.stringify(again));
  },
);
