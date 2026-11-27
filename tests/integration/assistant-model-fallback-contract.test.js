import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { shellGateway } from "../helpers/assistant-shell-gateway.js";
import { patchConfig } from "../../server/features/assistants/runtimes/openclaw/live-patch.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import { openClawRunEvent } from "../../server/features/assistants/runtimes/openclaw/openclaw-events.js";
import { withOpenClawEntries } from "../../server/features/assistants/runtimes/openclaw/openclaw-sessions.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
import { RunSteps } from "../../server/features/assistants/run-steps.js";

// What the pinned Gateway does with an agent's fallback models
// (`agents.entries.<id>.model.fallbacks`, which AgentPier compiles from
// runtimeOptions.openclaw.fallbacks, openclaw-config/agent-entry.js) when the agent's
// own model cannot answer, and how it reports the change.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};

// A provider that refuses every request as a rejected key: OpenClaw moves on to the
// next model at once (a server error or a rate limit is retried for minutes first).
async function refusingProvider(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    // The request is read to its end before it is refused.
    for await (const _part of req);
    requests.push(req.url);
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Invalid API key",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test(
  "a fallback model answers the turn the agent's own model cannot, and an empty list is strict",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "model-fallback-contract-" });
    gw.tool.name = "none";
    const broken = await refusingProvider(t);
    const model = (id) => ({ id, name: id, contextWindow: 32768, maxTokens: 4096 });
    const provider = (baseUrl, id) => ({
      baseUrl,
      api: "openai-completions",
      apiKey: "fixture-key",
      models: [model(id)],
    });
    await gw.configure({
      models: {
        providers: {
          // Provider ids as AgentPier writes them (assistant-models.js).
          "ap-own-1111": provider(broken.url, "own-model"),
          "ap-spare-2222": provider(gw.model.url, "vendor/spare-model"),
        },
      },
      tools: { allow: ["session_status"] },
    });
    const pid = gw.runtime.child.pid;
    const watcher = await gw.approver();
    const entryModel = async (fallbacks) => {
      await patchConfig(gw.client, () => ({
        patch: {
          agents: {
            entries: { main: { model: { primary: "ap-own-1111/own-model", fallbacks } } },
          },
        },
        // As agentPatch names it: a shorter list drops array items.
        replacePaths: ["agents.entries.main.model.fallbacks"],
      }));
      const { config } = await gw.client.call("config.get", {});
      return config.agents.entries.main.model;
    };
    const turn = async (label) => {
      const from = watcher.events.length;
      const asked = { own: broken.requests.length, spare: gw.model.requests.length };
      const session = await createGatewaySession(gw.client, { agentId: "main", label });
      const { runId } = await gw.client.call("sessions.send", {
        key: session.key,
        message: "Hello there.",
        idempotencyKey: label,
      });
      const done = await gw.client.call(
        "agent.wait",
        { runId, timeoutMs: 120000 },
        { timeoutMs: 125000 },
      );
      // The status line of a fallback follows the run's end.
      await delay(1500);
      return {
        session,
        runId,
        done,
        own: broken.requests.length - asked.own,
        spare: gw.model.requests.length - asked.spare,
        events: watcher.events
          .slice(from)
          .filter((frame) => frame.payload?.runId === runId)
          .map(openClawRunEvent),
      };
    };

    // Two fallbacks, the first one a model that no longer exists: OpenClaw skips it
    // at run time (no start or config failure) and the second one answers.
    assert.deepEqual(
      await entryModel(["ap-gone-3333/none", "ap-spare-2222/vendor/spare-model"]),
      {
        primary: "ap-own-1111/own-model",
        fallbacks: ["ap-gone-3333/none", "ap-spare-2222/vendor/spare-model"],
      },
    );
    const answered = await turn("with-fallback");
    assert.equal(answered.done.status, "ok");
    assert.equal(answered.own, 1, "the agent's own model is asked first");
    assert.equal(answered.spare, 1, "then the fallback, once");
    // OpenClaw's run receipt names both models.
    assert.deepEqual(answered.done.terminalReceipt.requested, {
      provider: "ap-own-1111",
      model: "own-model",
    });
    assert.equal(answered.done.terminalReceipt.effective.provider, "ap-spare-2222");
    assert.equal(answered.done.terminalReceipt.rerouted, true);

    // AgentPier's run events: a "fallback" step that names the model id alone, the
    // real reply, and OpenClaw's status line ("↪️ Model Fallback: …") as no reply.
    const steps = answered.events.map((event) => event.step).filter(Boolean);
    const fallback = steps.filter((step) => step.type === "fallback");
    t.diagnostic(`fallback steps: ${JSON.stringify(fallback)}`);
    assert.ok(fallback.length >= 1);
    assert.deepEqual(fallback.at(-1), {
      type: "fallback",
      model: "vendor/spare-model",
      failed: false,
    });
    const runSteps = new RunSteps();
    for (const event of answered.events) runSteps.observe(event);
    assert.deepEqual(
      runSteps.view(answered.runId).steps.filter((step) => step.kind === "fallback"),
      [{ id: "fallback", kind: "fallback", label: "vendor/spare-model", state: "done" }],
    );
    const finished = answered.events.filter((event) => event.kind === "finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].reply.text, "A useful assistant reply.");
    const notices = watcher.events.filter(
      (frame) =>
        frame.event === "chat" &&
        frame.payload?.runId === answered.runId &&
        JSON.stringify(frame.payload.message ?? "").includes("Model Fallback"),
    );
    assert.equal(notices.length, 1, "OpenClaw sends its status line as a chat frame");
    assert.equal(openClawRunEvent(notices[0]).kind, "progress");
    assert.equal(openClawRunEvent(notices[0]).reply, null);
    for (const event of answered.events)
      assert.equal(JSON.stringify(event.reply ?? "").includes("ap-"), false);

    // The transcript holds OpenClaw's own "Model switched from … to …" lines with the
    // internal provider ids; the chat shows the turn and the reply only.
    const history = await gw.client.call("chat.history", {
      sessionKey: answered.session.key,
      limit: 20,
    });
    const raw = JSON.stringify(history.messages);
    assert.ok(raw.includes("Model switched from ap-own-1111/own-model"), raw);
    const shown = publicMessages(withOpenClawEntries(history.messages));
    assert.deepEqual(
      shown.map((message) => [message.role, message.text]),
      [
        ["user", "Hello there."],
        ["assistant", "A useful assistant reply."],
      ],
    );

    // The session keeps the agent's own model: a fallback is no model switch.
    const { sessions } = await gw.client.call("sessions.list", {});
    const row = sessions.find((session) => session.key === answered.session.key);
    assert.equal(row.modelProvider, "ap-own-1111");
    assert.equal(row.model, "own-model");
    assert.equal(row.modelOverrideSource ?? null, null);

    // No fallbacks (`[]`, what AgentPier writes for an agent without any) is strict:
    // the turn fails and no other model is asked. It applies without a restart.
    assert.deepEqual(await entryModel([]), {
      primary: "ap-own-1111/own-model",
      fallbacks: [],
    });
    const strict = await turn("strict");
    // Its own model may not even be asked again: OpenClaw rests a refused key.
    t.diagnostic(`strict: ${strict.done.status}, own=${strict.own}`);
    assert.notEqual(strict.done.status, "ok");
    assert.equal(strict.spare, 0);
    assert.equal(
      strict.events.some((event) => event.step?.type === "fallback"),
      false,
    );
    assert.equal(gw.runtime.child.pid, pid);
  },
);
