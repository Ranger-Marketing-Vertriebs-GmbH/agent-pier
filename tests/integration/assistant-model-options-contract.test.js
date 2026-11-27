import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import http from "node:http";
import { shellGateway } from "../helpers/assistant-shell-gateway.js";
import { patchConfig } from "../../server/features/assistants/runtimes/openclaw/live-patch.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import { thinkingLevels } from "../../server/features/assistants/runtimes/openclaw/openclaw-options.js";

// What the pinned Gateway does with an agent's own thinking level, fast mode and
// loop protection (`agents.entries.<id>.thinkingDefault`, `.fastModeDefault` and
// `.tools.loopDetection.enabled`, which AgentPier compiles from
// runtimeOptions.openclaw, openclaw-config/agent-entry.js).
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};

test(
  "an agent's thinking level and fast mode apply live, and an unsupported level is clamped",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "model-options-contract-" });
    gw.tool.name = "none";
    const model = (id, extra) => ({
      id,
      name: id,
      contextWindow: 32768,
      maxTokens: 4096,
      ...extra,
    });
    await gw.configure({
      models: {
        providers: {
          thinker: {
            baseUrl: gw.model.url,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [model("reasons", { reasoning: true }), model("plain")],
          },
        },
      },
      tools: { allow: ["session_status"] },
    });
    const pid = gw.runtime.child.pid;
    const entry = async (patch) => {
      await patchConfig(gw.client, () => ({
        patch: { agents: { entries: { main: patch } } },
      }));
      const { config } = await gw.client.call("config.get", {});
      return config.agents.entries.main;
    };
    const turn = async (label) => {
      const run = await gw.send(label, "true");
      await gw.settle(run);
      return gw.model.requests.slice(run.from).at(-1);
    };
    await entry({ model: "thinker/reasons" });
    // Unset, a reasoning model of a custom endpoint thinks at OpenClaw's fallback.
    assert.equal((await turn("unset")).reasoning_effort, "medium");
    // Every level of the enum is accepted for every model. The next turn uses it; a
    // level this model does not declare is clamped to one it has, and "off" sends no
    // effort at all (a custom endpoint may not accept "none").
    const sent = {};
    for (const level of thinkingLevels) {
      const written = await entry({ thinkingDefault: level, fastModeDefault: true });
      assert.equal(written.thinkingDefault, level);
      assert.equal(written.fastModeDefault, true);
      const request = await turn(`level-${level}`);
      sent[level] = request.reasoning_effort;
      // Fast mode is a provider feature; a custom endpoint gets no tier.
      assert.equal(request.service_tier, undefined, level);
    }
    t.diagnostic(`efforts=${JSON.stringify(sent)}`);
    assert.deepEqual(sent, {
      off: undefined,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      adaptive: "medium",
      max: "high",
      ultra: "high",
    });
    // A chat that already ran follows a later change: no level sticks to a session.
    const session = await createGatewaySession(gw.client, { agentId: "main" });
    const again = async (idempotencyKey) => {
      const from = gw.model.requests.length;
      const { runId } = await gw.client.call("sessions.send", {
        key: session.key,
        message: "Again.",
        idempotencyKey,
      });
      await gw.settle({ runId, from });
      return gw.model.requests.slice(from).at(-1).reasoning_effort;
    };
    await entry({ thinkingDefault: "low" });
    assert.equal(await again("same-chat-low"), "low");
    await entry({ thinkingDefault: "high" });
    assert.equal(await again("same-chat-high"), "high");
    // null removes a key (a merge patch keeps an omitted one): the fallback is back.
    const removed = await entry({ thinkingDefault: null, fastModeDefault: null });
    assert.equal("thinkingDefault" in removed, false);
    assert.equal("fastModeDefault" in removed, false);
    assert.equal(await again("same-chat-unset"), "medium");
    // A model without thinking ignores any level instead of failing the turn.
    await entry({
      model: "thinker/plain",
      thinkingDefault: "max",
      fastModeDefault: false,
    });
    assert.equal((await turn("plain")).reasoning_effort, undefined);
    // All of it without a Gateway restart.
    assert.equal(gw.runtime.child.pid, pid);
  },
);

// A model that calls the same command again and again, whatever it is told, and
// answers in text only after `limit` requests of one session.
async function loopingModel(t, limit) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let bytes = "";
    for await (const part of req) bytes += part;
    if (!bytes) return res.writeHead(404).end();
    const input = JSON.parse(bytes);
    requests.push(input);
    const results = input.messages.filter((m) => m.role === "tool").length;
    const call = results < limit;
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: `loop-${results}`,
              type: "function",
              function: {
                name: "exec",
                arguments: JSON.stringify({ command: "echo same" }),
              },
            },
          ],
        }
      : { content: "Done." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "loop", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "loop", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test(
  "loop protection of one agent stops a model that repeats the same call",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "loop-protection-contract-" });
    const limit = 40;
    const looping = await loopingModel(t, limit);
    const tools = ["session_status", "exec", "process"];
    await gw.configure({
      models: {
        providers: {
          looper: {
            baseUrl: looping.url,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [{ id: "m", name: "M", contextWindow: 200000, maxTokens: 4096 }],
          },
        },
      },
      tools: { allow: tools, exec: { mode: "deny" } },
      agents: {
        entries: {
          main: { model: "looper/m", tools: { allow: tools, exec: { mode: "full" } } },
        },
      },
    });
    const pid = gw.runtime.child.pid;
    const run = async (label) => {
      const from = looping.requests.length;
      const session = await createGatewaySession(gw.client, { agentId: "main", label });
      const { runId } = await gw.client.call("sessions.send", {
        key: session.key,
        message: "Go.",
        idempotencyKey: label,
      });
      const done = await gw.client.call(
        "agent.wait",
        { runId, timeoutMs: 200000 },
        { timeoutMs: 205000 },
      );
      const seen = looping.requests.slice(from);
      const results = seen
        .at(-1)
        .messages.filter((m) => m.role === "tool")
        .map((m) => String(m.content));
      return { status: done.status, requests: seen.length, results };
    };
    const loop = async (value) => {
      await patchConfig(gw.client, () => ({
        patch: { agents: { entries: { main: { tools: { loopDetection: value } } } } },
      }));
      const { config } = await gw.client.call("config.get", {});
      return config.agents.entries.main.tools.loopDetection;
    };
    // OpenClaw's default: the rolling detectors are off, the model repeats until it
    // stops by itself.
    const off = await run("unprotected");
    assert.equal(off.status, "ok");
    assert.equal(off.requests, limit + 1);
    assert.ok(off.results.every((text) => text === "same"));
    // The agent's own switch (agents.entries.<id>.tools.loopDetection.enabled, as
    // agentEntry compiles it) applies to its next turn: a warning in the tool result
    // after 10 identical calls, then the block, and the turn ends.
    assert.deepEqual(await loop({ enabled: true }), { enabled: true });
    const on = await run("protected");
    t.diagnostic(`protected: ${on.status} after ${on.requests} requests`);
    assert.equal(on.status, "error");
    assert.ok(on.requests < limit, String(on.requests));
    assert.ok(
      on.results.some((text) =>
        text.includes("Tool-loop warning after 10 repeated calls"),
      ),
    );
    assert.match(
      on.results.at(-1),
      /CRITICAL: Called exec with identical outcomes 20 times\. Session execution blocked/,
    );
    // Off is the absent key, which a merge patch removes with null (never `false`,
    // which would also switch off OpenClaw's guard after a compaction).
    assert.equal(await loop(null), undefined);
    const again = await run("unprotected-again");
    assert.equal(again.status, "ok");
    assert.equal(again.requests, limit + 1);
    // All of it without a Gateway restart.
    assert.equal(gw.runtime.child.pid, pid);
  },
);
