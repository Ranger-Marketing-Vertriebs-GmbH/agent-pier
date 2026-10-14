import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import { routineTools } from "../../server/features/assistants/native-capabilities.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
const long = { timeoutMs: 60000 };
const text = (request) => JSON.stringify(request.messages);
const isRoutine = (request) => text(request).includes("ROUTINE_NATIVE_CONTRACT");
const offered = (request) => request.tools?.map((tool) => tool.function.name) ?? [];
const toolResults = (request) =>
  JSON.stringify(request.messages.filter((m) => m.role === "tool"));

test(
  "pinned native routines run with the agent's chat tools and land in its chat",
  { skip: !installed, timeout: 300000 },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, reminders, model, bridge;
    const page = http.createServer((req, res) => {
      page.hits++;
      res.end("PAGE_MARKER");
    });
    page.hits = 0;
    await new Promise((r) => page.listen(0, "127.0.0.1", r));
    t.after(async () => {
      await runtime?.close();
      await reminders?.close();
      await bridge?.close();
      await model?.close();
      page.closeAllConnections();
      await new Promise((r) => page.close(r));
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(
      id,
      {
        capabilities: { memory: true, reminders: true, webFetch: true, webSearch: false },
      },
      1,
    );
    const local = `http://127.0.0.1:${page.address().port}/news`;
    const notePath = "memory/news-sent.md";
    model = await proactivityModel();
    // The routine reads a workspace note, fetches a page, then answers. The fetch
    // targets a local fixture: OpenClaw refuses it before any request is sent,
    // which proves the tool ran (no internet involved).
    let quick = false;
    // A digest beyond OpenClaw's 2000-character run summary, its 8000-character
    // history default and Telegram's message limit.
    const digest = [
      "ROUTINE_SECOND without notes.",
      ...Array.from(
        { length: 30 },
        (_, n) =>
          `**Section ${n}**\n${"Some news of the day in a sentence. ".repeat(8)}[Quelle ${n}](https://news.example/${n})`,
      ),
    ].join("\n\n");
    model.reply = (request) => {
      if (!isRoutine(request)) return { text: "Chat reply." };
      if (quick) return { text: digest };
      const results = request.messages.filter((m) => m.role === "tool").length;
      if (results === 0)
        return { tool: { name: "read", arguments: { path: "memory/news-sent.md" } } };
      if (results === 1)
        return { tool: { name: "web_fetch", arguments: { url: local } } };
      // It records what it sent: write, then edit, the note it read.
      if (results === 2)
        return {
          tool: {
            name: "write",
            arguments: {
              path: notePath,
              content: "NOTE_MARKER sent on Monday\nSENT_TODAY\n",
            },
          },
        };
      if (results === 3)
        return {
          tool: {
            name: "edit",
            arguments: {
              path: notePath,
              oldText: "SENT_TODAY",
              newText: "SENT_TODAY_EDITED",
            },
          },
        };
      return { text: "ROUTINE_RESULT Three new items today." };
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
    f.assistants.requireReady = () => assert.ok(runtime.client?.ready);
    f.assistants.admit = (fn) => Promise.resolve().then(fn);
    reminders = new NativeReminders({
      assistants: f.assistants,
      channels: f.service,
      dataDir: f.dataDir,
    });
    f.assistants.reminders = reminders;
    const routines = new NativeRoutines({ reminders });
    f.assistants.routines = routines;
    const connection = await reminders.start();
    const completions = [];
    const complete = reminders.complete.bind(reminders);
    reminders.complete = (bindingId, event) => {
      completions.push(event);
      return complete(bindingId, event);
    };
    // The compiled native configuration: team plugin, memory, cron, web fetch.
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    // The real bridge answers the write guard: a routine's run is its own origin.
    bridge = new TeamBridge({
      assistants: f.assistants,
      generation: () => runtime.generation,
      teams: { store: { context: () => null } },
    });
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
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
    // Writes are granted in chat (a proven guard), never in a routine run.
    f.assistants.config.writeGuard = () => true;
    await f.assistants.config.apply(id);
    const agent = f.store.getAssistant(id);
    const workspace = path.join(runtime.paths.workspaces, id, "memory");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "news-sent.md"),
      "NOTE_MARKER sent on Monday\n",
    );
    // The paired conversation as AgentPier opens it: one native session per agent.
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
    // A chat turn first: it is offered the scheduling and write tools a run lacks.
    let offset = model.requests.length;
    const sent = await runtime.client.call(
      "sessions.send",
      { key: session.key, message: "Hello there.", idempotencyKey: randomUUID() },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    const chatTools = offered(model.requests[offset]);
    t.diagnostic(`chat tools=${JSON.stringify(chatTools)}`);
    for (const name of ["agentpier_routine", "agentpier_reminder", "write", "web_fetch"])
      assert.ok(chatTools.includes(name), `chat offers ${name}`);

    const routine = await routines.create(id, {
      clientRequestId: "contract-event",
      name: "News digest",
      prompt: "Collect today's news. ROUTINE_NATIVE_CONTRACT",
      trigger: { kind: "event", eventKind: "manual" },
    });
    const jobId = reminders.bindings.get(routine.id).nativeId;
    const job = async () => (await reminders.jobs(agent)).find((j) => j.id === jobId);
    const created = await job();
    assert.equal(created.enabled, false);
    assert.equal(created.sessionTarget, "current");
    assert.equal(created.sessionKey, session.key);
    assert.deepEqual(created.payload.toolsAllow, routineTools);

    // Existing jobs are migrated in place: shape the job as #192 created it.
    await runtime.client.call(
      "cron.update",
      {
        id: jobId,
        patch: {
          sessionTarget: "isolated",
          payload: {
            kind: "agentTurn",
            message: "Collect today's news. ROUTINE_NATIVE_CONTRACT",
            timeoutSeconds: 90,
            lightContext: true,
            toolsAllow: [],
          },
          delivery: { mode: "webhook", to: `${connection.url}/complete/${routine.id}` },
        },
      },
      long,
    );
    assert.deepEqual((await job()).payload.toolsAllow, []);
    await routines.reconcile();
    const migrated = await job();
    t.diagnostic(`migrated job=${JSON.stringify(migrated).slice(0, 1200)}`);
    assert.equal(migrated.sessionTarget, "current");
    assert.equal(migrated.sessionKey, session.key);
    assert.deepEqual(migrated.payload.toolsAllow, routineTools);
    assert.equal(migrated.payload.lightContext, false);
    assert.equal(migrated.payload.timeoutSeconds, 300);
    assert.equal(migrated.delivery.mode, "announce");
    assert.equal(migrated.enabled, false, "an event routine stays natively disabled");

    offset = model.requests.length;
    const receipt = await routines.trigger(id, routine.id, { eventId: "contract-1" });
    assert.equal(receipt.status, "queued");
    const deadline = Date.now() + 90000;
    while (!f.service.outbox.all(f.channel.id).length && Date.now() < deadline)
      await delay(200);
    const [delivered] = f.service.outbox.all(f.channel.id);
    assert.equal(delivered?.text, "ROUTINE_RESULT Three new items today.");

    const runRequests = model.requests.slice(offset).filter(isRoutine);
    const runTools = offered(runRequests[0]);
    t.diagnostic(`routine tools=${JSON.stringify(runTools)}`);
    assert.deepEqual(
      [...runTools].sort(),
      [
        "apply_patch",
        "edit",
        "memory_get",
        "memory_search",
        "read",
        "session_status",
        "web_fetch",
        "write",
      ],
      "the agent's chat tools without scheduling or a switched-off capability",
    );
    const results = toolResults(runRequests.at(-1));
    t.diagnostic(`routine tool results=${results.slice(0, 800)}`);
    assert.match(results, /NOTE_MARKER/, "read returns the workspace note");
    assert.match(
      results,
      /Blocked hostname or private\/internal\/special-use IP/,
      "web_fetch ran and refused the private target",
    );
    assert.equal(page.hits, 0);
    assert.doesNotMatch(results, /Only the owner's own messages may change files/);
    assert.equal(
      fs.readFileSync(path.join(workspace, "news-sent.md"), "utf8"),
      "NOTE_MARKER sent on Monday\nSENT_TODAY_EDITED\n",
      "the routine's run wrote and edited its note",
    );
    // Full context: the agent's conversation reaches the run.
    assert.match(text(runRequests[0]), /Hello there\./);

    // The result is committed into the conversation and badged in AgentPier's chat.
    const history = async () =>
      (await runtime.client.call("chat.history", { sessionKey: session.key }, long))
        .messages;
    const commitDeadline = Date.now() + 30000;
    while (
      !JSON.stringify(await history()).includes("ROUTINE_RESULT") &&
      Date.now() < commitDeadline
    )
      await delay(250);
    const service = {
      store: f.store,
      ledger: f.assistants.ledger,
      runtime,
      routines,
    };
    const chat = await conversationHistory(service, conversation.id);
    const result = chat.messages.find((m) => m.text.includes?.("ROUTINE_RESULT"));
    assert.deepEqual(result?.scheduled, { name: "News digest" });
    assert.equal(
      chat.messages.filter((m) => m.role === "assistant" && m.scheduled).length,
      1,
      "shown once, from the conversation itself",
    );
    // A later chat turn knows what the routine said.
    offset = model.requests.length;
    const followUp = await runtime.client.call(
      "sessions.send",
      {
        key: session.key,
        message: "What did you send this morning?",
        idempotencyKey: randomUUID(),
      },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: followUp.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    assert.ok(
      model.requests.slice(offset).some((r) => text(r).includes("ROUTINE_RESULT")),
      "the follow-up turn sees the routine's result",
    );

    assert.deepEqual(
      await routines.trigger(id, routine.id, { eventId: "contract-1" }),
      receipt,
    );
    // A capability switched off leaves the next run without its tools, while the
    // job itself is unchanged: the cap is intersected with the agent's tools.allow.
    const before = await job();
    f.store.updateAssistant(
      id,
      { capabilities: { memory: false, reminders: true, webFetch: true } },
      f.store.getAssistant(id).revision,
    );
    await f.assistants.config.apply(id);
    await routines.reconcile();
    assert.deepEqual((await job()).payload, before.payload);
    quick = true;
    offset = model.requests.length;
    await routines.trigger(id, routine.id, { eventId: "contract-2" });
    const second = Date.now() + 90000;
    while (f.service.outbox.all(f.channel.id).length < 2 && Date.now() < second)
      await delay(200);
    // OpenClaw caps the webhook's summary; the run's session has the whole reply,
    // which Telegram receives in several messages.
    const cappedRun = completions.at(-1);
    assert.equal(cappedRun.summary, `${digest.slice(0, 2000)}…`);
    assert.match(
      cappedRun.sessionKey,
      new RegExp(`^agent:[^:]+:cron:${jobId}:run:[^:]+$`, "i"),
    );
    const full = f.service.outbox.all(f.channel.id)[1];
    assert.ok(digest.length > 8000);
    assert.equal(full?.text, digest);
    assert.ok(full.parts.length > 1);
    assert.equal(routines.results.forConversation(conversation.id).at(-1)?.text, digest);
    // The chat reads the committed digest whole (beyond OpenClaw's 8000-character
    // history default) and badges it.
    let shown;
    const shownDeadline = Date.now() + 30000;
    do {
      shown = (await conversationHistory(service, conversation.id)).messages.find((m) =>
        m.text?.startsWith?.("ROUTINE_SECOND"),
      );
      if (!shown) await delay(250);
    } while (!shown && Date.now() < shownDeadline);
    assert.equal(shown?.text, digest);
    assert.deepEqual(shown.scheduled, { name: "News digest" });
    const narrowed = offered(model.requests.slice(offset).find(isRoutine));
    t.diagnostic(`routine tools without memory=${JSON.stringify(narrowed)}`);
    assert.deepEqual([...narrowed].sort(), ["session_status", "web_fetch"]);

    const runs = await routines.runs(id, routine.id);
    assert.equal(runs.entries.filter((r) => r.status === "ok").length, 2);
    await routines.remove(id, routine.id);
    assert.equal((await routines.list(id)).routines.length, 0);
  },
);
