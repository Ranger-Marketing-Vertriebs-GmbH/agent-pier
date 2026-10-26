import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

// Against the pinned Gateway: a Telegram turn starts a background command and ends;
// when it exits, OpenClaw's own completion run in the chat's session answers. That
// answer reaches the paired Telegram chat exactly once (telegram-follow-ups.js). This
// pins what the delivery assumes of OpenClaw: the completion run's lifecycle end
// reaches the chat's subscriber with the chat's session key and a run id no attempt
// has, the transcript (`sessions.get`) shows its user entry with the exec provenance
// right before the run's first record, and `chat.history` names its reply by that
// run id.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const long = { timeoutMs: 60000 };
const text = (m) =>
  typeof m?.content === "string"
    ? m.content
    : (Array.isArray(m?.content) ? m.content : [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
const turnMessage = (m) =>
  m.role === "user" && !JSON.stringify(m.content).includes("OpenClaw runtime context");
const lastUser = (request) =>
  request.messages.slice(request.messages.findLastIndex(turnMessage));
// 2026.10.3's "An async command you ran earlier has completed ...", 2026.10.7's bare
// `[<time>] Exec <status> (<id8>, <exit>) …` line.
const isCompletion = (request) => {
  const prompt = text(lastUser(request)[0]) || "";
  return /async command/i.test(prompt) || /^\[[^\]]*\] Exec [a-z]+ \(/.test(prompt);
};

test(
  "pinned Gateway: a completion run's reply reaches the paired Telegram chat once",
  { skip: !installed, timeout: contractTimeout(300000) },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, model;
    t.after(async () => {
      await runtime?.close();
      await model?.close();
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(
      id,
      { capabilities: { memory: false, reminders: false }, shell: "full" },
      1,
    );
    model = await proactivityModel();
    model.reply = (request) => {
      if (JSON.stringify(lastUser(request)[0]).includes("<conversation>"))
        return { text: "Summary." };
      if (isCompletion(request)) return { text: "Rendered: the video is ready." };
      return lastUser(request).some((m) => m.role === "tool")
        ? { text: "Started in the background." }
        : {
            tool: {
              name: "exec",
              arguments: { command: "sleep 3; echo RENDERED", background: true },
            },
          };
    };
    runtime = new RuntimeSupervisor({
      dataDir: f.dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    f.assistants.runtime = runtime;
    const gatewayEvents = new GatewayEventHub(),
      events = [];
    // As ChannelService wires it at construction.
    gatewayEvents.on("agent", (payload) => {
      events.push(payload);
      f.service.followUps.observe(payload);
    });
    await runtime.start();
    gatewayEvents.bind(runtime.client);
    const config = new AssistantConfig({
      client: runtime.client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    config.nativeReady = () => true;
    config.writeGuard = () => true;
    await config.apply(id);
    const agent = f.store.getAssistant(id);
    fs.mkdirSync(path.join(runtime.paths.workspaces, id), { recursive: true });
    const session = await runtime.client.call(
      "sessions.create",
      { agentId: agent.runtimeAgentId, label: `AgentPier ${id}` },
      long,
    );
    await runtime.client.call("sessions.messages.subscribe", { key: session.key }, long);
    const conversation = f.store.getConversation(f.channel.conversationId);
    f.store.db
      .prepare("UPDATE conversations SET session_key=?, body=? WHERE id=?")
      .run(
        session.key,
        JSON.stringify({ ...conversation, runtimeSessionKey: session.key }),
        conversation.id,
      );
    // The chat's history as AgentPier reads it.
    f.assistants.history = async () => {
      const page = await runtime.client.call(
        "chat.history",
        { sessionKey: session.key, limit: 100 },
        long,
      );
      return { stale: false, messages: publicMessages(page.messages) };
    };
    const contexts = new Map();
    f.assistants.teams = {
      store: { context: (requestId) => contexts.get(requestId), list: () => [] },
    };
    const sent = [];
    f.client.call = async (method, input) => {
      if (method !== "sendMessage") return true;
      sent.push(input.text);
      return { message_id: sent.length, chat: { id: 42 } };
    };

    // The owner's turn from the paired chat, sent as AgentPier sends it.
    const request = f.assistants.ledger.accept(conversation.id, {
      clientRequestId: randomUUID(),
      text: "Render the video in the background.",
    });
    contexts.set(request.id, {
      kind: "telegram",
      channelId: f.channel.id,
      chatId: "42",
      userId: "42",
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    const turn = await runtime.client.call(
      "sessions.send",
      { key: session.key, message: request.text, idempotencyKey: attempt.id },
      long,
    );
    f.assistants.ledger.transition(attempt.id, "running", { runtimeRunId: turn.runId });
    await runtime.client.call(
      "agent.wait",
      { runId: turn.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    f.assistants.ledger.transition(attempt.id, "completed");

    const signal = new AbortController().signal;
    const deadline = Date.now() + contractTimeout(60000);
    while (Date.now() < deadline && !sent.includes("Rendered: the video is ready.")) {
      await f.service.followUps.process(f.channel.id, signal);
      await f.service.teamOutbox.process(f.channel.id, signal);
      await delay(250);
    }
    const [row] = f.service.followUps.all(f.channel.id);
    t.diagnostic(`follow-up=${JSON.stringify(row)}`);
    t.diagnostic(
      `run events=${JSON.stringify(
        events
          .filter((e) => e.runId === row?.runId)
          .map((e) => ({
            stream: e.stream,
            phase: e.data?.phase,
            session: e.sessionKey,
          })),
      )}`,
    );
    assert.ok(row, "the completion run's end was recorded");
    assert.notEqual(row.runId, turn.runId);
    assert.notEqual(row.runId, attempt.id);
    assert.equal(row.sessionKey, session.key);
    assert.equal(row.state, "queued");
    // The owner turn's own run is no follow-up.
    assert.equal(f.service.followUps.all(f.channel.id).length, 1);
    assert.deepEqual(sent, ["Rendered: the video is ready."]);

    // More passes and a repeated end event send nothing again.
    f.service.followUps.observe({
      runId: row.runId,
      sessionKey: session.key,
      stream: "lifecycle",
      data: { phase: "end" },
    });
    for (let n = 0; n < 3; n++) {
      await f.service.followUps.process(f.channel.id, signal);
      await f.service.teamOutbox.process(f.channel.id, signal);
    }
    assert.deepEqual(sent, ["Rendered: the video is ready."]);
  },
);
