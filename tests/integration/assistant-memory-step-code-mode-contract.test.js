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
import { createGatewaySession } from "../../server/features/assistants/session-create.js";
import {
  MemoryStepWrites,
  memoryStepText,
} from "../../server/features/assistants/memory-step.js";

// AGENTPIER-250: an agent in OpenClaw Code Mode sees only `exec` (a JavaScript cell)
// and `wait`, and calls write and edit from the cell. Its memory step runs one cell
// that saves the day note and tries a file outside its memory.
const note = "memory/2026-10-26.md";
const cellCode = [
  `await write({ path: ${JSON.stringify(note)}, content: "stepfact\\n" });`,
  "let outside = 'written';",
  "try { await write({ path: 'notes.md', content: 'planted' }); }",
  "catch (error) { outside = 'refused'; }",
  "return outside;",
].join("\n");

// Answers the memory step with one Code Mode cell, then with text; records the tools
// each request offers and the cell's result.
async function codeModeModel(seen) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const step = JSON.stringify(body.messages).includes("AgentPier memory step");
    const answered =
      body.messages.findLastIndex((m) => m.role === "tool") >
      body.messages.findLastIndex((m) => m.role === "user");
    seen.push({
      tools: (body.tools || []).map((tool) => tool.function?.name),
      results: body.messages.filter((m) => m.role === "tool").map((m) => m.content),
    });
    const delta =
      step && !answered
        ? {
            tool_calls: [
              {
                index: 0,
                id: "memory-cell",
                type: "function",
                function: {
                  name: "exec",
                  arguments: JSON.stringify({ title: "Save memory", code: cellCode }),
                },
              },
            ],
          }
        : { content: "Saved." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: delta.tool_calls ? "tool_calls" : "stop",
          },
        ],
      },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "cell", object: "chat.completion.chunk", model: body.model, ...item })}\n\n`,
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

const packageRoot = process.env.AGENTPIER_TEAM_CONTRACT_RUNTIME;
test(
  "pinned runtime: a Code Mode agent's memory step saves its memory from a cell",
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
        "memory-step-code-mode-",
      ),
    );
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db),
      contexts = new Map(),
      memoryStepWrites = new MemoryStepWrites();
    const seen = [];
    const model = await codeModeModel(seen);
    let agent = store.createAssistant({
      name: "Coder",
      instructions: "Owner instructions.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
    });
    agent = store.updateAssistant(
      agent.id,
      { capabilities: { memory: true, reminders: false } },
      agent.revision,
    );
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
      assistants: { store, ledger, runtime, memoryStepWrites },
      generation: () => runtime.generation,
      teams: { store: { context: (id) => contexts.get(id) || { kind: "unknown" } } },
    });
    const policies = [];
    const toolPolicy = bridge.toolPolicy.bind(bridge);
    bridge.toolPolicy = (input) => {
      const result = toolPolicy(input);
      Promise.resolve(result).then((r) => policies.push({ ...input, ...r }));
      return result;
    };
    t.after(async () => {
      await runtime.close();
      await bridge.close();
      await model.close();
      store.close();
      if (!process.env.AGENTPIER_KEEP_CONTRACT_DIR)
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    runtime.teamConfiguration = async (installed) => ({
      directory: installed.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "code-mode-fixture" },
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
            baseUrl: model.url,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [
              {
                id: "fixture-model",
                name: "Fixture",
                contextWindow: 32768,
                maxTokens: 4096,
                // The catalog flag that engages Code Mode under its default "auto".
                compat: { codeMode: "preferred" },
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
    const workspace = path.join(runtime.paths.workspaces, agent.id);
    const created = await createGatewaySession(runtime.client, {
      agentId: agent.runtimeAgentId,
      label: "Code Mode memory step",
    });
    const chat = store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: created.key,
    });
    const request = ledger.accept(chat.id, {
        clientRequestId: `memory-step:${crypto.randomUUID()}`,
        text: memoryStepText,
      }),
      attempt = ledger.recordAttempt(request.id);
    contexts.set(request.id, { kind: "memory-step" });
    const sent = await runtime.client.call("sessions.send", {
      key: created.key,
      message: memoryStepText,
      idempotencyKey: attempt.id,
    });
    ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
    const done = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    const written = memoryStepWrites.written(attempt.id);
    ledger.transition(attempt.id, "completed");
    const diagnostics = JSON.stringify({ done, seen, policies });
    // Code Mode engaged: the model saw the cell, not the file tools.
    assert.ok(seen[0].tools.includes("exec"), diagnostics);
    assert.ok(!seen[0].tools.includes("write"), diagnostics);
    // The locked-tool hook admitted the cell by its kind.
    assert.ok(
      policies.some(
        (p) => p.toolName === "exec" && p.toolKind === "code_mode_exec" && p.allow,
      ),
      diagnostics,
    );
    // The cell's own write met the write guard and saved the note; the file outside
    // the agent's memory was refused inside the cell.
    assert.equal(fs.readFileSync(path.join(workspace, note), "utf8"), "stepfact\n");
    assert.equal(fs.existsSync(path.join(workspace, "notes.md")), false);
    assert.ok(
      policies.some((p) => p.toolName === "write" && p.path === note && p.allow),
      diagnostics,
    );
    assert.ok(
      policies.some((p) => p.toolName === "write" && p.path === "notes.md" && !p.allow),
      diagnostics,
    );
    assert.match(JSON.stringify(seen.at(-1).results), /refused/, diagnostics);
    assert.equal(written, true, "the step counts its admitted write");
  },
);
