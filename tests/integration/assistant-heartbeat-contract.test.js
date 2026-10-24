import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeHeartbeats } from "../../server/features/assistants/native-heartbeats.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { telegramMessages } from "../../server/features/assistant-channels/telegram-messages.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { stepPolicyBridge } from "../helpers/assistant-step-policy-bridge.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

const installed = process.env.AGENTPIER_PROACTIVITY_CONTRACT_RUNTIME;
const long = { timeoutMs: 60000 };
const text = (request) => JSON.stringify(request.messages);
const isCheckIn = (request) =>
  text(request).includes("scheduled check-in from AgentPier");

test(
  "pinned native check-ins run in the agent's conversation and reach only the paired chat",
  { skip: !installed, timeout: contractTimeout(300000) },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, reminders, model, bridge;
    t.after(async () => {
      await runtime?.close();
      await reminders?.close();
      await model?.close();
      await bridge?.close();
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(
      id,
      {
        instructions: "INSTRUCTIONTOKEN Keep replies short.",
        capabilities: { memory: true, reminders: false },
        // Every hour of the day, so the job is always due within its active hours.
        heartbeat: { enabled: true, interval: "1h", start: 0, end: 24, timeZone: "UTC" },
      },
      1,
    );
    model = await proactivityModel();
    let checkIn = "Your dentist moved to Friday. HEARTBEATCONTRACT";
    // A check-in first reads MEMORY.md, as its prompt asks: a detached run gets no
    // workspace notes in its prompt (see the diagnostic below).
    model.reply = (request) =>
      isCheckIn(request) && !request.messages.some((m) => m.role === "tool")
        ? { tool: { name: "memory_get", arguments: { path: "MEMORY.md" } } }
        : isCheckIn(request)
          ? { text: checkIn }
          : text(request).includes("SLOWTURN")
            ? { text: "Slow owner answer.", delayMs: 6000 }
            : { text: "Hi." };
    runtime = new RuntimeSupervisor({
      dataDir: f.dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    f.assistants.runtime = runtime;
    f.assistants.requireReady = () => assert.ok(runtime.client?.ready);
    f.assistants.admit = (fn) => Promise.resolve().then(fn);
    reminders = new NativeReminders({
      assistants: f.assistants,
      channels: f.service,
      dataDir: f.dataDir,
    });
    f.assistants.reminders = reminders;
    const pushes = [],
      received = [];
    const heartbeats = new NativeHeartbeats({
      reminders,
      notifications: { notify: async (input) => pushes.push(input) },
    });
    const complete = heartbeats.complete.bind(heartbeats);
    heartbeats.complete = (binding, event) => {
      received.push(event.summary);
      return complete(binding, event);
    };
    const connection = await reminders.start();
    // The compiled native configuration: memory-core, cron and the webhook policy.
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    // Every native tool call asks the bridge whether it runs in a memory step.
    bridge = await stepPolicyBridge("heartbeat-fixture");
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: bridge.connection,
      hostMaxConcurrent: 4,
      native: { token: connection.token },
      profiles: f.store.listAssistants(),
    });
    await runtime.start();
    f.assistants.config = new AssistantConfig({
      client: runtime.client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    f.assistants.config.nativeReady = () => true;
    await f.assistants.config.apply(id);
    await new NativeMemory(f.assistants).write(id, {
      name: "MEMORY.md",
      content: "MEMORYTOKEN The owner sees the dentist every spring.\n",
      expectedMissing: true,
    });
    // The paired conversation as AgentPier opens it: one native session per agent.
    const agent = f.store.getAssistant(id);
    const session = await runtime.client.call(
      "sessions.create",
      { agentId: agent.runtimeAgentId, label: `AgentPier ${id}` },
      long,
    );
    const conversation = f.store.getConversation(f.channel.conversationId);
    f.store.db
      .prepare("UPDATE conversations SET session_key=?, body=? WHERE id=?")
      .run(
        session.key,
        JSON.stringify({ ...conversation, runtimeSessionKey: session.key }),
        conversation.id,
      );
    const send = async (message) =>
      runtime.client.call(
        "sessions.send",
        { key: session.key, message, idempotencyKey: randomUUID() },
        long,
      );
    const wait = async (sent) =>
      runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
    const history = async () =>
      (await runtime.client.call("chat.history", { sessionKey: session.key }, long))
        .messages;
    const visible = async () =>
      (await history()).map((m) =>
        [m.role, JSON.stringify(m.content).includes("HEARTBEATCONTRACT")].join(":"),
      );
    assert.equal(
      (await wait(await send("CONVERSATIONTOKEN I fly to Rome."))).status,
      "ok",
    );

    await heartbeats.sync(id);
    const [job] = (await reminders.jobs(agent)).filter((j) =>
      j.declarationKey?.startsWith("agentpier-reminder:"),
    );
    assert.equal(job.sessionTarget, "current");
    assert.equal(job.sessionKey, session.key);
    assert.ok(job.state.nextRunAtMs > Date.now(), "the hourly schedule is armed");
    // OpenClaw's own per-agent heartbeat stays off (agents.defaults.heartbeat 0m).
    assert.ok(
      (await reminders.jobs(agent))
        .filter((j) => j.declarationKey === `heartbeat:${agent.runtimeAgentId}`)
        .every((j) => j.enabled === false),
    );
    const finished = async (count) => {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const entries = (
          await runtime.client.call("cron.runs", { id: job.id, limit: 20 }, long)
        ).entries;
        if (entries.filter((e) => e.action === "finished").length >= count)
          return entries;
        await delay(250);
      }
      assert.fail(`check-in run ${count} did not finish`);
    };
    // OpenClaw logs a run "finished" before it clears the job's active marker
    // (finalizeCompletedCronRunOutcomes), so a force right after the previous run may
    // still be refused as already running (AGENTPIER-198).
    const force = async () => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const result = await runtime.client.call(
          "cron.run",
          { id: job.id, mode: "force" },
          long,
        );
        if (result?.reason !== "already-running" || Date.now() > deadline)
          return assert.equal(result?.enqueued, true, JSON.stringify(result));
        await delay(200);
      }
    };

    // 1. A check-in with content, full context, into the conversation and the chat.
    let offset = model.requests.length;
    await force();
    await finished(1);
    const outboxDeadline = Date.now() + 30000;
    while (!f.service.outbox.all(f.channel.id).length && Date.now() < outboxDeadline)
      await delay(200);
    const runRequests = model.requests.slice(offset).filter(isCheckIn);
    const runRequest = runRequests[0];
    assert.match(
      JSON.stringify(runRequests.at(-1).messages.filter((m) => m.role === "tool")),
      /MEMORYTOKEN/,
      "the check-in reads the agent's MEMORY.md",
    );
    assert.ok(
      bridge.calls.some((c) => c.url === "/step-policy" && c.authorized),
      "the check-in's tool call asked the bridge's step policy",
    );
    assert.match(text(runRequest), /MEMORY\.md/, "the prompt asks for MEMORY.md");
    assert.ok(runRequest, "the check-in prompt reached the model");
    assert.match(text(runRequest), /INSTRUCTIONTOKEN/, "the agent's instructions");
    assert.match(text(runRequest), /CONVERSATIONTOKEN/, "the recent conversation");
    // MEMORY.md is not part of any turn's prompt here (skipBootstrap): check-ins,
    // like chat turns, reach notes through memory_search and memory_get.
    const memoryInPrompt = JSON.stringify(
      model.requests.map((r) => [
        isCheckIn(r) ? "check-in" : text(r).slice(-80),
        text(r).includes("MEMORYTOKEN"),
      ]),
    );
    assert.deepEqual(
      runRequest.tools.map((tool) => tool.function.name).sort(),
      ["memory_get", "memory_search"],
      "memory is reachable, read-only",
    );
    const [delivered] = f.service.outbox.all(f.channel.id);
    assert.equal(delivered.kind, "heartbeat");
    assert.equal(
      delivered.text,
      `${telegramMessages(f.channel).heartbeatPrefix} ${checkIn}`,
    );
    assert.equal(delivered.chatId, f.channel.chatId);
    assert.deepEqual(await visible(), [
      "user:false",
      "assistant:false",
      "assistant:true",
    ]);
    offset = model.requests.length;
    assert.equal((await wait(await send("Thanks, move it then."))).status, "ok");
    assert.ok(
      model.requests.slice(offset).some((r) => text(r).includes("HEARTBEATCONTRACT")),
      "the owner's reply turn sees the check-in",
    );
    const pushDeadline = Date.now() + 10000;
    while (!pushes.length && Date.now() < pushDeadline) await delay(100);
    assert.deepEqual(
      pushes.map((p) => p.kind),
      ["agent-checkin"],
    );

    // 2. NO_REPLY: nothing in the conversation, nothing sent. Its run also proves
    // fresh context: the owner's reply was sent after the job was created.
    const before = await visible();
    checkIn = "NO_REPLY";
    offset = model.requests.length;
    await force();
    const runs = await finished(2);
    assert.ok(
      model.requests
        .slice(offset)
        .filter(isCheckIn)
        .some((r) => text(r).includes("Thanks, move it then.")),
      "each run reads the conversation as it is now, not as it was at creation",
    );
    await delay(1000);
    assert.deepEqual(await visible(), before, "NO_REPLY leaves no visible message");
    assert.equal(f.service.outbox.all(f.channel.id).length, 1);

    // 3. Due while the owner's turn runs: the result waits for that turn to end.
    checkIn = "MIDTURN check-in HEARTBEATCONTRACT";
    const slow = await send("SLOWTURN please think it over");
    await delay(500);
    await force();
    assert.equal((await wait(slow)).status, "ok");
    const after = await finished(3);
    const roles = (await history()).map((m) =>
      JSON.stringify(m.content).includes("MIDTURN")
        ? "check-in"
        : JSON.stringify(m.content).includes("Slow owner answer")
          ? "owner-answer"
          : JSON.stringify(m.content).includes("SLOWTURN")
            ? "owner-question"
            : "other",
    );
    assert.deepEqual(
      roles.filter((r) => r !== "other"),
      ["owner-question", "owner-answer", "check-in"],
      "the check-in is committed after the running turn, not inside it",
    );
    // 4. After an owner /reset and /new the same job reads the new session and
    // still commits into it: no snapshot of the old one is kept.
    let count = 3;
    for (const command of ["/reset", "/new"]) {
      assert.equal((await wait(await send(command))).status, "ok");
      const marker = `AFTER${command.slice(1).toUpperCase()}TOKEN`;
      assert.equal((await wait(await send(`${marker} a new topic.`))).status, "ok");
      checkIn = `${marker} check-in HEARTBEATCONTRACT`;
      offset = model.requests.length;
      const sent = f.service.outbox.all(f.channel.id).length;
      await force();
      const entries = await finished(++count);
      const request = model.requests.slice(offset).find(isCheckIn);
      assert.match(text(request), new RegExp(marker), `${command}: fresh session read`);
      assert.doesNotMatch(
        text(request),
        /CONVERSATIONTOKEN/,
        `${command}: old one dropped`,
      );
      assert.equal(entries[0].deliveryStatus, "delivered", `${command}: committed`);
      assert.ok(
        JSON.stringify(await history()).includes(`${marker} check-in`),
        `${command}: in the conversation`,
      );
      const deadline = Date.now() + 10000;
      while (f.service.outbox.all(f.channel.id).length === sent && Date.now() < deadline)
        await delay(100);
      assert.equal(f.service.outbox.all(f.channel.id).length, sent + 1);
    }
    t.diagnostic(
      `MEMORY.md in any prompt: ${memoryInPrompt}; webhook summaries: ${JSON.stringify(received)}; run delivery statuses: ${JSON.stringify(after.map((e) => e.deliveryStatus))}; NO_REPLY run: ${JSON.stringify(runs.find((e) => e.summary === "NO_REPLY") || null).slice(0, 300)}.`,
    );

    // Switching check-ins off removes the native job.
    f.store.updateAssistant(
      id,
      { heartbeat: { ...agent.heartbeat, enabled: false } },
      f.store.getAssistant(id).revision,
    );
    await heartbeats.sync(id);
    assert.deepEqual(
      (await reminders.jobs(f.store.getAssistant(id))).filter((j) =>
        j.declarationKey?.startsWith("agentpier-reminder:"),
      ),
      [],
    );
  },
);
