import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import http from "node:http";
import { shellGateway } from "../helpers/assistant-shell-gateway.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { RunSteps } from "../../server/features/assistants/run-steps.js";
import { longContext } from "../../server/features/assistants/conversations.js";

// What the pinned Gateway tells a client about a running turn (AGENTPIER-184): the
// `agent` events AgentPier turns into live steps (run-steps.js), how a model that
// stops answering ends the turn, and the context size the long-chat hint reads.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const tools = ["session_status", "exec", "process"];
const permissions = {
  tools: { allow: tools, exec: { mode: "deny" } },
  agents: { entries: { main: { tools: { allow: tools, exec: { mode: "full" } } } } },
};
const ofRun = (events, runId) => events.filter((e) => e.payload?.runId === runId);

test(
  "a turn's tool calls reach every operator connection as item events with a safe title",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "run-steps-contract-" });
    await gw.configure(permissions);
    // A connection that did not start the run (a Telegram or routine turn for
    // AgentPier) declares no tool-events cap and still hears the item events.
    const watcher = await gw.approver();
    const run = await gw.send("titled", {
      command: "echo TOKEN=secret-value-123",
      title: "Figurenreferenz ermitteln",
    });
    const settled = await gw.settle(run);
    assert.equal(settled.result, "TOKEN=secret-value-123");
    const events = ofRun(watcher.events, run.runId);
    const items = events
      .filter((e) => e.event === "agent" && e.payload.stream === "item")
      .map((e) => e.payload.data);
    assert.deepEqual(
      items.map((d) => [d.kind, d.name, d.phase, d.status, d.meta]),
      [
        ["tool", "exec", "start", "running", "Figurenreferenz ermitteln"],
        ["tool", "exec", "update", "running", "Figurenreferenz ermitteln"],
        ["tool", "exec", "end", "completed", "Figurenreferenz ermitteln"],
      ],
      JSON.stringify(items),
    );
    assert.ok(items.every((d) => d.itemId === items[0].itemId && d.commandBearing));
    // The raw `tool` stream (arguments, results) needs the tool-events cap: never here.
    assert.equal(
      events.some((e) => e.event === "agent" && e.payload.stream === "tool"),
      false,
    );
    // Command output does arrive, which is why run-steps.js drops that stream.
    assert.ok(
      events.some(
        (e) =>
          e.payload.stream === "command_output" &&
          e.payload.data.output.includes("secret-value-123"),
      ),
    );
    const phases = events
      .filter((e) => e.payload.stream === "lifecycle")
      .map((e) => e.payload.data.phase);
    assert.ok(
      ["start", "model", "end"].every((p) => phases.includes(p)),
      phases.join(),
    );
    assert.ok(
      events.some(
        (e) =>
          e.payload.stream === "run_status" && e.payload.data.phase === "starting_model",
      ),
    );
    // AgentPier's view of these frames: the title, never the command or its output.
    const steps = new RunSteps();
    for (const event of events) steps.observe(event);
    const view = steps.view(run.runId);
    assert.deepEqual(view.steps, [
      {
        id: items[0].itemId,
        kind: "tool",
        tool: "exec",
        label: "Figurenreferenz ermitteln",
        state: "done",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(view), /secret-value|TOKEN/);
    // Without a title OpenClaw summarises the command; the secret stays out of it.
    const untitled = await gw.send("untitled", "echo TOKEN=secret-value-456");
    await gw.settle(untitled);
    const summary = ofRun(watcher.events, untitled.runId).find(
      (e) => e.payload.stream === "item",
    ).payload.data.meta;
    assert.doesNotMatch(summary, /secret-value|TOKEN/, summary);
    // The session's context size after a turn (the long-chat hint, conversations.js).
    const history = await gw.client.call("chat.history", {
      sessionKey: untitled.session.key,
      limit: 5,
    });
    const info = history.sessionInfo;
    assert.equal(info.totalTokensFresh, true, JSON.stringify(info));
    assert.ok(Number.isFinite(info.totalTokens) && info.totalTokens > 0);
    assert.equal(info.contextTokens, 32768);
    assert.equal(longContext(info), false);
  },
);

test(
  "a model that stops answering ends the turn with a timeout after retries",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "run-stall-contract-" });
    // Streams one piece of text, then never another byte.
    const server = http.createServer(async (req, res) => {
      let bytes = "";
      for await (const part of req) bytes += part;
      if (!bytes) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "h", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "Partial" }, finish_reason: null }] })}\n\n`,
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    // A loopback provider has no implicit idle watchdog; its timeoutSeconds is one,
    // as the 120 s default is for cloud providers (builtin-openclaw llm-idle-timeout).
    await patchConfig(gw.client, () => ({
      patch: {
        models: {
          providers: {
            silent: {
              baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
              api: "openai-completions",
              apiKey: "fixture-key",
              timeoutSeconds: 3,
              models: [{ id: "m", name: "M", contextWindow: 32768, maxTokens: 4096 }],
            },
          },
        },
        ...permissions,
        agents: { ...permissions.agents, defaults: { model: { primary: "silent/m" } } },
      },
    }));
    const watcher = await gw.approver();
    const session = await gw.client.call("sessions.create", { agentId: "main" });
    const sent = await gw.client.call("sessions.send", {
      key: session.key,
      message: "Hello",
      idempotencyKey: "silent-run",
    });
    const done = await gw.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 200000 },
      { timeoutMs: 205000 },
    );
    assert.equal(done.status, "error", JSON.stringify(done));
    const events = ofRun(watcher.events, sent.runId);
    // Each retry is an event: a turn that retries is not silent.
    const retries = events.filter(
      (e) => e.payload.stream === "run_status" && e.payload.data.phase === "retrying",
    );
    assert.ok(retries.length > 0);
    assert.equal(retries[0].payload.data.reason, "timeout");
    assert.ok(Number.isInteger(retries[0].payload.data.maxRetries));
    const ended = events.find(
      (e) => e.event === "chat" && e.payload.state === "error" && e.payload.errorKind,
    );
    assert.equal(ended?.payload.errorKind, "timeout", JSON.stringify(events.at(-1)));
    const steps = new RunSteps();
    for (const event of retries) steps.observe(event);
    assert.equal(steps.view(sent.runId).phase, "retrying");
  },
);
