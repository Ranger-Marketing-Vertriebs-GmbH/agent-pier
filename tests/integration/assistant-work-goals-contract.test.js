import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { CompletionRuns } from "../../server/features/assistants/exec-continuation.js";
import { backgroundMethod } from "../../server/features/assistants/team-plugin/background-commands.js";
import { continuationPrompt } from "../../server/features/assistants/goal-turns.js";
import { nudgeDelayMs } from "../../server/features/assistants/work-goal-nudges.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

// AGENTPIER-208 against the pinned Gateway: the owner's turn sets a work goal with
// agentpier_goal and starts a background command. While the command runs the nudge
// holds (the plugin's agentpier.backgroundCommands answers from the Gateway's exec
// record); once OpenClaw's completion run has ended and the chat was idle for
// `nudgeDelayMs`, AgentPier sends one continuation in the same chat. The continuation
// writes with its anchor's owner rights and ends the goal with agentpier_goal done.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const long = { timeoutMs: 60000 };
const continuationMark = "This is AgentPier, not the owner.";
// The turn's own message: OpenClaw adds a runtime context message (the active exec
// sessions) to the model's prompt while a background command runs.
const turnMessage = (m) =>
  m.role === "user" && !JSON.stringify(m.content).includes("OpenClaw runtime context");
const lastUser = (request) =>
  request.messages.slice(request.messages.findLastIndex(turnMessage));
const asked = (request) => JSON.stringify(lastUser(request)[0]);
const text = (m) =>
  typeof m?.content === "string"
    ? m.content
    : (Array.isArray(m?.content) ? m.content : [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
// The completion run's prompt: 2026.10.3's "An async command you ran earlier has
// completed ...", 2026.10.7's bare `[<time>] Exec <status> (<id8>, <exit>) …` line.
const isCompletion = (request) => {
  const prompt = text(lastUser(request)[0]) || "";
  return /async command/i.test(prompt) || /^\[[^\]]*\] Exec [a-z]+ \(/.test(prompt);
};
const openClawVersion = (dir) =>
  JSON.parse(
    fs.readFileSync(path.join(dir, "app/node_modules/openclaw/package.json"), "utf8"),
  ).version;

test(
  "pinned Gateway: a work goal continues in its chat until the agent ends it",
  { skip: !installed, timeout: contractTimeout(300000) },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime,
      model,
      teams,
      shift = 0;
    t.after(async () => {
      await teams?.close();
      await runtime?.close();
      await model?.close();
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(
      id,
      { capabilities: { memory: true, reminders: false }, shell: "full" },
      1,
    );
    model = await proactivityModel();
    const summary = "Wrote notes/goal.md.";
    model.reply = (request) => {
      // A summary request (OpenClaw's compaction) gets a summary.
      if (asked(request).includes("<conversation>")) return { text: "Summary." };
      if (isCompletion(request)) return { text: "ok" };
      const steps = lastUser(request).filter((m) => m.role === "tool").length;
      // The continuation writes the note and ends the goal; the owner's turn sets
      // the goal and backgrounds a command.
      const plan = asked(request).includes(continuationMark)
        ? [
            {
              name: "write",
              arguments: { path: "notes/goal.md", content: "GOAL\n" },
            },
            { name: "agentpier_goal", arguments: { action: "done", summary } },
          ]
        : [
            {
              name: "agentpier_goal",
              arguments: {
                action: "set",
                title: "Goal note",
                done: "notes/goal.md exists",
                steps: "Write notes/goal.md",
              },
            },
            // OpenClaw announces a silent successful exit with no completion run
            // (tools.exec.notifyOnExitEmptySuccess), so the command prints. It runs
            // until the test creates `.release`, so the held ticks see it running.
            {
              name: "exec",
              arguments: {
                command: "while [ ! -e .release ]; do sleep 0.1; done; echo SLEPT",
                background: true,
              },
            },
          ];
      return steps < plan.length ? { tool: plan[steps] } : { text: "Started." };
    };
    runtime = new RuntimeSupervisor({
      dataDir: f.dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const completionRuns = new CompletionRuns(),
      gatewayEvents = new GatewayEventHub(),
      events = [];
    Object.assign(f.assistants, { runtime, completionRuns, gatewayEvents });
    gatewayEvents.on("agent", (payload) => {
      events.push(payload);
      completionRuns.observe(payload);
    });
    // The goals' clock runs `shift` ahead of the Gateway's.
    teams = new TeamService({
      assistants: f.assistants,
      autoStart: false,
      now: () => Date.now() + shift,
    });
    f.assistants.teams = teams;
    const bridge = (teams.bridge = new TeamBridge({
      assistants: f.assistants,
      teams,
      generation: () => runtime.generation,
    }));
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "work-goals-fixture" },
      profiles: f.store.listAssistants(),
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
    const workspace = path.join(runtime.paths.workspaces, id);
    fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });

    const session = await runtime.client.call(
      "sessions.create",
      { agentId: agent.runtimeAgentId, label: `AgentPier ${id}` },
      long,
    );
    await runtime.client.call("sessions.messages.subscribe", { key: session.key }, long);
    const chat = f.store.getConversation(f.channel.conversationId);
    f.store.db
      .prepare("UPDATE conversations SET session_key=?, body=? WHERE id=?")
      .run(
        session.key,
        JSON.stringify({ ...chat, runtimeSessionKey: session.key }),
        chat.id,
      );

    // A turn as AgentPier sends it (conversation-turns.js): the request with its
    // trusted context, the attempt id as the idempotency key; it settles once the run
    // ends. The nudge sends its continuations through the same path.
    const sends = [];
    f.assistants.send = async (conversationId, input, context = { kind: "owner" }) => {
      const request = f.assistants.ledger.accept(conversationId, input);
      teams.store.recordContext(request.id, context);
      const attempt = f.assistants.ledger.recordAttempt(request.id);
      const sent = await runtime.client.call(
        "sessions.send",
        { key: session.key, message: input.text, idempotencyKey: attempt.id },
        long,
      );
      f.assistants.ledger.transition(attempt.id, "running", { runtimeRunId: sent.runId });
      const settled = runtime.client
        .call("agent.wait", { runId: sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 })
        .then(() => f.assistants.ledger.transition(attempt.id, "completed"));
      // A failed assertion before the await must not leave an unhandled rejection.
      settled.catch(() => {});
      sends.push({ input, context, request, attempt, runId: sent.runId, settled });
      return { request, attempt };
    };
    const background = () =>
      runtime.client.call(backgroundMethod, { sessionKey: session.key }, long);
    const tick = async (ms) => {
      shift = ms;
      await teams.goals.tick();
    };

    // 1. The owner's turn sets the goal, anchored on its own request.
    await f.assistants.send(chat.id, {
      clientRequestId: randomUUID(),
      text: "Write the goal note and keep working until it is done.",
    });
    const owner = sends[0];
    await owner.settled;
    const goal = teams.goals.store.open(chat.id);
    assert.ok(goal, "the owner's turn set a goal");
    assert.equal(goal.anchorRequestId, owner.request.id);
    assert.equal(goal.setRequestId, owner.request.id);

    // 2. While the command runs, the Gateway reports it and the nudge holds.
    const running = await background();
    t.diagnostic(`while running=${JSON.stringify(running)}`);
    assert.equal(running.running, 1);
    await tick(0);
    await tick(nudgeDelayMs);
    assert.equal(sends.length, 1, "no continuation while the command runs");
    fs.writeFileSync(path.join(workspace, ".release"), "");

    // 3. OpenClaw's completion run in the chat's session ends. 2026.10.3 marks its
    // events heartbeat-driven; 2026.10.7's ordinary event turn has no marked event,
    // so it is the session's one run that is not the owner's.
    const eventTurns = !/^2026\.(9\.|10\.[0-5]$)/.test(openClawVersion(installed));
    const ended = (e) =>
      (eventTurns
        ? e.isHeartbeat === false && e.runId !== owner.runId
        : e.isHeartbeat === true) &&
      e.sessionKey === session.key &&
      e.stream === "lifecycle" &&
      ["end", "error"].includes(e.data?.phase);
    const deadline = Date.now() + contractTimeout(60000);
    while (!events.some(ended) && Date.now() < deadline) await delay(200);
    const completionRun = events.find(ended)?.runId;
    t.diagnostic(`completion run=${completionRun}`);
    assert.ok(completionRun, "the completion run ended");
    assert.notEqual(completionRun, owner.runId);
    assert.ok(model.requests.some(isCompletion), "the model answered the completion run");
    assert.deepEqual(completionRuns.live(session.key), []);
    const finished = await background();
    t.diagnostic(`after completion=${JSON.stringify(finished)}`);
    assert.equal(finished.running, 0);
    assert.equal(finished.completing, 0, "no completion run holds the chat");

    // 4. Idle for the delay on the goals' clock: one continuation, as the owner's.
    const base = 2 * nudgeDelayMs;
    await tick(base);
    assert.equal(sends.length, 1, "the delay starts once the chat is idle");
    await tick(base + nudgeDelayMs);
    assert.equal(sends.length, 2, "one continuation");
    const continuation = sends[1];
    assert.match(continuation.input.clientRequestId, /^goal-continuation:/);
    assert.equal(continuation.input.text, continuationPrompt(goal));
    assert.equal(continuation.context.kind, "owner");
    assert.equal(continuation.context.goal.anchorRequestId, owner.request.id);
    await continuation.settled;

    // 5. The model got the continuation prompt as the turn's user message and wrote
    // the note: the tool guard admitted the write as the owner's turn.
    const prompted = model.requests.filter((r) => asked(r).includes(continuationMark));
    assert.ok(prompted.length, "the model received the continuation");
    const user = lastUser(prompted[0])[0];
    assert.equal(user.role, "user");
    assert.ok(
      JSON.stringify(user.content).includes(
        JSON.stringify(continuationPrompt(goal)).slice(1, -1),
      ),
      "the continuation prompt is the user message",
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, "notes/goal.md"), "utf8"),
      "GOAL\n",
    );

    // The Gateway's item events name each tool, the plugin's goal tool too: the
    // no-progress brake leaves agentpier_goal out (work-goals.js observe).
    const tools = new Set(
      events
        .filter(
          (e) =>
            e.runId === continuation.runId &&
            e.stream === "item" &&
            e.data?.kind === "tool",
        )
        .map((e) => e.data.name),
    );
    t.diagnostic(`continuation tools=${JSON.stringify([...tools])}`);
    assert.deepEqual([...tools].sort(), ["agentpier_goal", "write"]);
    teams.goals.toolRuns.clear();
    for (const e of events)
      if (e.runId === continuation.runId && e.data?.name === "agentpier_goal")
        teams.goals.observe(e);
    assert.equal(teams.goals.toolRun(continuation.runId), false);

    // 6. The agent ended the goal; later ticks send nothing more.
    const final = teams.goals.store.list(chat.id).at(-1);
    assert.equal(final.id, goal.id);
    assert.equal(final.state, "done");
    assert.equal(final.summary, summary);
    assert.equal(teams.goals.store.open(chat.id), null);
    await tick(base + 3 * nudgeDelayMs);
    await tick(base + 5 * nudgeDelayMs);
    assert.equal(sends.length, 2, "no further continuation");
  },
);
