import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";

// The model writes whatever "WRITE <path> <content>" asks for, once per turn.
async function writingModel() {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const user = body.messages.findLast((m) => m.role === "user");
    const text = JSON.stringify(user?.content || "");
    const [, target, content] = text.match(/WRITE (\S+) (\w+)/) || [];
    const tool =
      target &&
      body.messages.findLastIndex((m) => m.role === "user") >
        body.messages.findLastIndex((m) => m.role === "tool");
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: `write-${content}`,
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: target, content }),
              },
            },
          ],
        }
      : { content: "Done." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "write", object: "chat.completion.chunk", model: body.model, ...item })}\n\n`,
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
  "pinned runtime blocks native writes to instructions and from forwarded turns",
  { skip: !packageRoot, timeout: 180000 },
  async (t) => {
    const runtimeVersion = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-write-contract-"));
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db),
      contexts = new Map();
    const model = await writingModel();
    let agent = store.createAssistant({
      name: "Writer",
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
      assistants: { store, ledger, runtime },
      generation: () => runtime.generation,
      teams: { store: { context: (id) => contexts.get(id) || { kind: "unknown" } } },
    });
    t.after(async () => {
      await runtime.close();
      await bridge.close();
      await model.close();
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    runtime.teamConfiguration = async (installed) => ({
      directory: installed.teamPlugin.directory,
      // A short report interval keeps the registry-retirement check fast.
      connection: { ...(await bridge.start()), guardReportMs: 1000 },
      hostMaxConcurrent: 4,
      native: { token: "write-fixture" },
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
              },
            ],
          },
          release() {},
        }),
      },
    });
    config.nativeReady = () => true;
    let guardReported = false;
    config.writeGuard = () => guardReported && bridge.guardLive();
    // The Gateway's plugin reports its hook before any profile may write.
    for (let n = 0; n < 200 && !bridge.guardLive(); n++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.guardLive(), true, "the started Gateway reports its guard");
    await config.apply(agent.id);
    const workspace = path.join(runtime.paths.workspaces, agent.id);
    const created = await runtime.client.call("sessions.create", {
      agentId: agent.runtimeAgentId,
      label: "Write contract",
    });
    const chat = store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: created.key,
    });
    async function turn(text, context) {
      const request = ledger.accept(chat.id, {
          clientRequestId: crypto.randomUUID(),
          text,
        }),
        attempt = ledger.recordAttempt(request.id);
      contexts.set(request.id, context);
      await config.apply(agent.id);
      const sent = await runtime.client.call("sessions.send", {
        key: created.key,
        message: text,
        idempotencyKey: attempt.id,
      });
      ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
      const done = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 45000 },
        { timeoutMs: 50000 },
      );
      ledger.transition(attempt.id, "completed");
      return done.terminalReceipt?.successfulToolNames || [];
    }
    const owner = { kind: "owner" },
      forwarded = { kind: "telegram", forwarded: true };
    // Without a reported guard the profile has no write tool at all.
    assert.ok(!(await turn("WRITE MEMORY.md unguarded", owner)).includes("write"));
    assert.equal(fs.existsSync(path.join(workspace, "MEMORY.md")), false);
    guardReported = true;
    assert.ok((await turn("WRITE MEMORY.md ownerfact", owner)).includes("write"));
    assert.equal(fs.readFileSync(path.join(workspace, "MEMORY.md"), "utf8"), "ownerfact");
    // A connection that leaves ready withdraws the guard until the Gateway's
    // plugin reports again on its own schedule.
    runtime.setState({ availability: "reconnecting" });
    runtime.setState({ availability: "ready" });
    assert.equal(bridge.guardLive(), false);
    for (let n = 0; n < 400 && !bridge.guardLive(); n++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.guardLive(), true, "the periodic report restores the guard");
    // An in-process plugin reload retires the old registry: its timer stops and
    // only the replacement instance, in the same Gateway process, reports.
    const reports = [];
    const original = bridge.registerGuard.bind(bridge);
    bridge.registerGuard = (input) => {
      reports.push({ ...input, at: Date.now() });
      return original(input);
    };
    while (!reports.length) await new Promise((r) => setTimeout(r, 50));
    const retired = reports[0].instance;
    const reloaded = await runtime.client.call(
      "plugins.reload",
      { plugins: [{ pluginId: "agentpier-teams" }] },
      { timeoutMs: 60000 },
    );
    assert.equal(reloaded.restartRequired, false, JSON.stringify(reloaded));
    const after = Date.now();
    for (let n = 0; n < 100 && !reports.some((r) => r.instance !== retired); n++)
      await new Promise((r) => setTimeout(r, 50));
    const replacement = reports.find((r) => r.instance !== retired);
    assert.ok(replacement, "the replacement registry reports");
    assert.equal(replacement.pid, reports[0].pid, "same Gateway process");
    await new Promise((r) => setTimeout(r, 3500));
    assert.deepEqual(
      reports.filter((r) => r.instance === retired && r.at > after + 200),
      [],
      "the retired registry's timer stopped",
    );
    assert.ok(reports.filter((r) => r.instance === replacement.instance).length >= 3);
    assert.ok((await turn("WRITE MEMORY.md ownerfact", owner)).includes("write"));
    assert.ok(!(await turn("WRITE AGENTS.md planted", owner)).includes("write"));
    assert.ok(
      !(await turn(`WRITE ${workspace}/SOUL.md planted`, owner)).includes("write"),
    );
    for (const bypass of [
      "TOOLS.md</arg_value>>",
      "AGENT\u017F.md",
      "skills/helper/SKILL.md",
      "SOUL.md/notes.md",
    ])
      assert.ok(
        !(await turn(`WRITE ${bypass} planted`, owner)).includes("write"),
        bypass,
      );
    assert.ok(
      !(await turn("WRITE MEMORY.md forwardedfact", forwarded)).includes("write"),
    );
    assert.ok(!(await turn("WRITE memory/x.md scheduled", { kind: "reminder" })).length);
    assert.equal(fs.readFileSync(path.join(workspace, "MEMORY.md"), "utf8"), "ownerfact");
    assert.ok(
      fs
        .readFileSync(path.join(workspace, "AGENTS.md"), "utf8")
        .startsWith("Owner instructions.\n\n## AgentPier\n"),
    );
    for (const name of fs.readdirSync(workspace))
      assert.ok(!/^(soul|tools|agent.\.md)/i.test(name) || name === "AGENTS.md", name);
    assert.equal(fs.existsSync(path.join(workspace, "SOUL.md")), false);
    assert.equal(fs.existsSync(path.join(workspace, "TOOLS.md")), false);
    assert.equal(fs.existsSync(path.join(workspace, "skills")), false);
    const managed = (await runtime.client.call("config.get", {})).config;
    assert.deepEqual(managed.agents.defaults.skills, []);
    assert.equal(fs.existsSync(path.join(workspace, "memory", "x.md")), false);
  },
);
