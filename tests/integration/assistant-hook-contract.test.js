import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { AgentHooks } from "../../server/features/assistants/agent-hooks.js";
import { hookMarkers } from "../../server/features/assistants/agent-hook-prompt.js";
import {
  effectiveRights,
  hookTools,
} from "../../server/features/assistants/agent-hook-rights.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

// AGENTPIER-216 against the pinned Gateway: an incoming hook event wakes its agent.
// AgentHooks.deliver creates one disabled cron job per event and forces its run in
// the agent's main chat (agent-hook-runs.js); the run's tool calls carry the cron
// run session that AgentHooks.runOrigin resolves; the completion webhook settles the
// event and removes the job. A background command the run started completes after
// the event settled; 2026.10.7 starts no completion turn for it (recorded here),
// and any such turn would get no hook rights (agent-hook-bridge.js hookLockedTool). The model is a local double; nothing reaches the internet.
const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
const long = { timeoutMs: 60000 };
const marker = "HOOK_NATIVE_CONTRACT";
const json = (value) => JSON.stringify(value);
const offered = (request) => request.tools?.map((tool) => tool.function.name) ?? [];
const content = (m) =>
  typeof m?.content === "string"
    ? m.content
    : (Array.isArray(m?.content) ? m.content : [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
// The turn's own message: OpenClaw adds a runtime context message (the active exec
// sessions) to the prompt while a background command runs.
const turnMessage = (m) =>
  m.role === "user" && !json(m.content).includes("OpenClaw runtime context");
const lastUser = (request) =>
  request.messages.slice(request.messages.findLastIndex(turnMessage));
const isHook = (request) => json(request.messages).includes(marker);
// 2026.10.7's exec completion prompt: `[<time>] Exec <status> (<id8>, <exit>) …`.
const isCompletion = (request) => {
  const prompt = content(lastUser(request)[0]) || "";
  return /async command/i.test(prompt) || /^\[[^\]]*\] Exec [a-z]+ \(/.test(prompt);
};
const stepped = (request) => lastUser(request).some((m) => m.role === "tool");

async function until(check, ms, what) {
  const deadline = Date.now() + contractTimeout(ms);
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(200);
  }
  assert.fail(`${what} within ${ms / 1000} s`);
}

test(
  "pinned Gateway: a hook event runs once in the main chat with only its rights",
  { skip: !installed, timeout: contractTimeout(300000) },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, reminders, model, bridge, hooks;
    t.after(async () => {
      hooks?.runs.close();
      await runtime?.close();
      await reminders?.close();
      await bridge?.close();
      await model?.close();
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(
      id,
      {
        capabilities: { memory: true, reminders: true, webFetch: true, webSearch: false },
        shell: "full",
      },
      1,
    );
    model = await proactivityModel();
    // The run starts a background command and answers; a completion turn of that
    // command, should one run after the event settled, tries a foreground one.
    const backgroundDone = path.join(f.dataDir, "hook-background-done");
    model.reply = (request) => {
      if (!isHook(request)) return { text: "Chat reply." };
      if (isCompletion(request))
        return stepped(request)
          ? { text: "LATE_DONE" }
          : { tool: { name: "exec", arguments: { command: "echo LATE_SHELL" } } };
      if (!stepped(request))
        return {
          tool: {
            name: "exec",
            arguments: {
              command: `sleep 6; echo done > ${JSON.stringify(backgroundDone)}`,
              background: true,
            },
          },
        };
      return { text: "HOOK_RESULT Disk on db1 is full; I started a check." };
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
    // No project, SSH or folder grants: the hook's ceiling is the agent's own tools.
    // A granted secret comes later (the Secrets section below).
    const grants = { projectIds: [], sshAccesses: [] };
    f.assistants.workflows = {
      access: { get: () => grants, sshHosts: () => [] },
      folders: { ownAndShared: () => ({}) },
    };
    const audits = [];
    f.assistants.audit = { append: (event) => audits.push(event) };
    const gatewayEvents = new GatewayEventHub();
    f.assistants.gatewayEvents = gatewayEvents;
    const pushes = [];
    const notifications = { notify: async (input) => pushes.push(input) };
    reminders = new NativeReminders({
      assistants: f.assistants,
      channels: f.service,
      dataDir: f.dataDir,
      notifications,
    });
    f.assistants.reminders = reminders;
    const routines = new NativeRoutines({ reminders });
    f.assistants.routines = routines;
    hooks = new AgentHooks({
      reminders,
      routines,
      notifications,
      addresses: (hookId) => ({ local: `http://127.0.0.1:4380/hooks/${hookId}` }),
    });
    const connection = await reminders.start();
    // Every completion that reaches the hook route, as OpenClaw sent it.
    const completions = [];
    const receiveHook = reminders.webhook.receiveHook;
    reminders.webhook.receiveHook = (rowId, event) => {
      completions.push({ rowId, event });
      return receiveHook(rowId, event);
    };
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    bridge = new TeamBridge({
      assistants: f.assistants,
      generation: () => runtime.generation,
      teams: { store: { context: () => null } },
    });
    // Every locked-tool decision with the hook origin it had at that moment.
    const decisions = [];
    const decide = bridge.toolPolicy.bind(bridge);
    bridge.toolPolicy = (input) => {
      const origin = hooks.runOrigin(f.store.getAssistant(id), input?.sessionKey);
      const settle = (result) => {
        decisions.push({ ...input, allow: result.allow, eventId: origin?.event.id });
        return result;
      };
      const result = decide(input);
      return result instanceof Promise ? result.then(settle) : settle(result);
    };
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: connection.token },
      profiles: f.store.listAssistants(),
    });
    await runtime.start();
    gatewayEvents.bind(runtime.client);
    f.assistants.config = new AssistantConfig({
      client: runtime.client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    f.assistants.config.nativeReady = () => true;
    f.assistants.config.writeGuard = () => true;
    await f.assistants.config.apply(id);
    const agent = f.store.getAssistant(id);

    // The paired conversation as AgentPier opens it: one native session per agent.
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
        json({ ...conversation, runtimeSessionKey: session.key }),
        conversation.id,
      );
    // A chat turn first: the agent's chat tools, with scheduling and the hook tool.
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
    t.diagnostic(`chat tools=${json(chatTools)}`);
    for (const name of ["agentpier_routine", "exec", "write", "web_fetch"])
      assert.ok(chatTools.includes(name), `chat offers ${name}`);

    const { hook: created, secret } = hooks.create(id, {
      name: "Zabbix",
      sender: "zabbix01",
      instruction: "Tell me which host is affected.",
      rights: { notify: true, research: true, memory: true, shell: "full" },
    });
    assert.match(secret, /^aph_/);
    const hook = hooks.store.get(created.id);
    const payload = json({ id: "contract-1", alert: `${marker} disk full on db1` });
    offset = model.requests.length;
    const delivered = await hooks.deliver(hook, {
      text: payload,
      json: JSON.parse(payload),
      contentType: "application/json",
      size: Buffer.byteLength(payload),
      headers: {},
      source: "local",
    });
    assert.deepEqual(delivered, {
      status: 202,
      body: { eventId: "contract-1", status: "accepted" },
    });
    const event = hooks.events.find(hook.id, "contract-1");
    assert.equal(event.status, "running");
    const declarationKey = `agentpier-hook:${event.id}`;
    const hookJobs = async () =>
      (await reminders.jobs(null)).filter((j) => j.declarationKey === declarationKey);
    // The disabled one-shot job, forced at once (cron.run mode force enqueues it).
    const [job] = await hookJobs();
    t.diagnostic(`hook job=${json(job).slice(0, 1600)}`);
    assert.equal(job?.id, event.jobId);
    assert.equal(job.enabled, false);
    assert.equal(job.agentId, agent.runtimeAgentId);
    assert.equal(job.sessionTarget, "current");
    assert.equal(job.sessionKey, session.key);
    assert.equal(job.payload.lightContext, false);
    assert.equal(job.payload.timeoutSeconds, 300);
    assert.ok(job.payload.message.startsWith("This is the AgentPier hook"));
    const ceiling = hooks.ceiling(agent);
    assert.deepEqual(
      job.payload.toolsAllow,
      hookTools(effectiveRights(hook.rights, ceiling), ceiling),
    );
    assert.deepEqual(
      [...job.payload.toolsAllow].sort(),
      [
        "edit",
        "exec",
        "memory_get",
        "memory_search",
        "process",
        "read",
        "session_status",
        "web_fetch",
        "write",
      ],
      "the ticks' tools",
    );

    // The completion webhook arrives on the hook route and settles the event.
    const completion = await until(
      () => completions.find((c) => c.rowId === String(event.id)),
      90000,
      "no hook completion arrived",
    );
    t.diagnostic(`completion=${json(completion.event).slice(0, 800)}`);
    assert.equal(completion.event.jobId, event.jobId);
    assert.equal(completion.event.status, "ok");
    assert.equal(completion.event.deliveryStatus, "delivered");
    const runSessionKey = completion.event.sessionKey;
    assert.match(
      runSessionKey,
      new RegExp(`^agent:${agent.runtimeAgentId}:cron:${event.jobId}:run:[^:]+$`, "i"),
    );
    const settled = await until(
      () => hooks.events.get(event.id).status !== "running" && hooks.events.get(event.id),
      30000,
      "the event did not settle",
    );
    t.diagnostic(`settled event=${json({ ...settled, payload: undefined })}`);
    assert.equal(settled.status, "done");
    assert.equal(settled.reply, "HOOK_RESULT Disk on db1 is full; I started a check.");
    assert.deepEqual(settled.notified, { push: true, telegram: false });
    assert.deepEqual(
      pushes.map((p) => [p.kind, p.conversationId, p.eventId]),
      [["agent-routine", conversation.id, `hook-${event.id}`]],
    );

    // The run: offered exactly toolsAllow ∩ the agent's tools, never scheduling,
    // the hook tool or team tools; its exec call carried the cron run session that
    // runOrigin resolved to this event.
    const runRequests = model.requests
      .slice(offset)
      .filter((r) => isHook(r) && !isCompletion(r));
    const runTools = offered(runRequests[0]);
    t.diagnostic(`hook run tools=${json(runTools)}`);
    for (const name of ["agentpier_routine", "agentpier_reminder", "agentpier_hook"])
      assert.ok(!runTools.includes(name), `a hook run never offers ${name}`);
    // OpenClaw implies apply_patch wherever write is allowed; the write guard
    // refuses it in a hook run (hookWrite admits write and edit to memory only).
    const capped = job.payload.toolsAllow.filter((name) => chatTools.includes(name));
    assert.deepEqual(
      [...runTools].sort(),
      [...capped, ...(capped.includes("write") ? ["apply_patch"] : [])].sort(),
      "toolsAllow intersected with the agent's tools",
    );
    // The run sees the main chat: full context.
    assert.match(json(runRequests[0].messages), /Hello there\./);
    const runExec = decisions.find(
      (d) => d.toolName === "exec" && d.sessionKey !== session.key,
    );
    t.diagnostic(`run exec decision=${json(runExec)}`);
    assert.equal(runExec?.allow, true, "the run's own shell");
    assert.equal(runExec.eventId, event.id, "runOrigin resolved the run's session");
    assert.match(
      runExec.sessionKey,
      new RegExp(`^agent:${agent.runtimeAgentId}:cron:${event.jobId}:run:[^:]+$`, "i"),
    );

    // The reply was committed once into the main chat's native session.
    const history = async () =>
      (await runtime.client.call("chat.history", { sessionKey: session.key }, long))
        .messages;
    await until(
      async () => json(await history()).includes("HOOK_RESULT"),
      30000,
      "the reply was not committed to the main chat",
    );
    const raw = await history();
    const replies = raw.filter(
      (m) => m.role === "assistant" && json(m.content).includes("HOOK_RESULT"),
    );
    assert.equal(replies.length, 1, "the reply appears once in chat.history");
    // Whether OpenClaw itself shows the prompt in the main chat's transcript.
    const promptShown = raw.some(
      (m) => m.role === "user" && json(m.content).includes(hookMarkers.start),
    );
    t.diagnostic(`main chat.history shows the hook prompt=${promptShown}`);
    t.diagnostic(
      `main chat.history roles=${json(raw.map((m) => [m.role, json(m.content).slice(0, 80)]))}`,
    );
    // AgentPier's view of the main chat never shows the prompt or its payload.
    const service = { store: f.store, ledger: f.assistants.ledger, runtime, routines };
    const chat = await conversationHistory(service, conversation.id);
    for (const m of chat.messages) {
      const shown = json(m);
      assert.ok(!shown.includes(marker), "the payload never shows as a message");
      assert.ok(!shown.includes(hookMarkers.start), "the prompt never shows");
      assert.ok(!shown.includes("not a message from the owner"));
    }
    const row = chat.events.find((e) => e.id === `hook:${event.id}`);
    assert.equal(row?.status, "done");
    assert.equal(row.firstLine, "HOOK_RESULT Disk on db1 is full; I started a check.");

    // The background command completes after the event settled. Measured on
    // 2026.10.7: the cron run's session keeps no transcript and the command's exit
    // wakes no completion turn, neither there nor in the main chat. Should a later
    // runtime start one, the model double calls exec there, which the bridge must
    // refuse (agent-hook-bridge.js hookLockedTool), and this contract records it.
    await until(() => fs.existsSync(backgroundDone), 60000, "the command did not end");
    await delay(contractTimeout(20000));
    const lateTurns = model.requests.slice(offset).filter(isCompletion);
    t.diagnostic(
      `exec completion turns=${lateTurns.length} tools=${json(lateTurns.map(offered))}`,
    );
    const lateExec = decisions.filter((d) => d.toolName === "exec" && d !== runExec);
    t.diagnostic(`late exec decisions=${json(lateExec)}`);
    assert.ok(
      lateExec.every((d) => d.allow === false && d.eventId === undefined),
      "no shell after the event settled",
    );
    assert.equal(lateTurns.length, 0, "2026.10.7 starts no exec completion turn");
    for (const key of [runSessionKey, session.key]) {
      const page = await runtime.client.call("sessions.get", { key, limit: 100 }, long);
      assert.ok(
        !page.messages.some((m) => m.provenance?.sourceTool === "exec"),
        `no exec completion entry in ${key}`,
      );
    }
    assert.equal(hooks.events.get(event.id).status, "done", "the event stays settled");

    // The job is gone once its completion was handled.
    await until(async () => !(await hookJobs()).length, 30000, "the hook job remained");
    // AgentPier serves the endpoint itself: OpenClaw's own hooks stay off.
    const compiled = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8"));
    assert.equal("hooks" in compiled, false, "no hooks in openclaw.json");
    // The delivery is audited without its payload.
    const audit = audits.find((a) => a.details?.kind === "hook-delivery");
    assert.equal(audit?.details.outcome, "accepted");
    assert.ok(!json(audits).includes(marker));

    // Secrets (AGENTPIER-243). A hook run without Secrets and without shell, coding
    // or MCP keeps the agent's secrets file in place for its other chats; the tool
    // guard refuses that run's own read of it (team-plugin/secrets-guard.js, the
    // bridge's /secrets-policy). A hook with Secrets reads it like a chat does.
    grants.secretIds = ["contract-secret"];
    const secretsFile = path.join(
      runtime.paths.workspaces,
      id,
      ".agentpier",
      "secrets.env",
    );
    const seeded =
      "# Managed by AgentPier. Do not edit; changes are overwritten.\nCONTRACT_TOKEN='fixture'\n";
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretsFile, seeded, { mode: 0o600 });
    const readMarker = "HOOK_SECRETS_CONTRACT";
    model.reply = (request) => {
      if (!json(request.messages).includes(readMarker)) return { text: "Chat reply." };
      if (!stepped(request))
        return { tool: { name: "read", arguments: { path: ".agentpier/secrets.env" } } };
      return { text: "SECRETS_DONE" };
    };
    // One event of a hook with the given rights; the read's tool result.
    const readThrough = async (name, rights, eventId) => {
      const { hook: reader } = hooks.create(id, { name, sender: "vault01", rights });
      const stored = hooks.store.get(reader.id);
      const body = json({ id: eventId, alert: `${readMarker} ${eventId}` });
      const from = model.requests.length;
      const answer = await hooks.deliver(stored, {
        text: body,
        json: JSON.parse(body),
        contentType: "application/json",
        size: Buffer.byteLength(body),
        headers: {},
        source: "local",
      });
      assert.equal(answer.status, 202, `${name} accepted`);
      const started = hooks.events.find(stored.id, eventId);
      const [readerJob] = (await reminders.jobs(null)).filter(
        (j) => j.declarationKey === `agentpier-hook:${started.id}`,
      );
      assert.ok(readerJob.payload.toolsAllow.includes("read"), `${name} may read`);
      for (const tool of ["exec", "process", "agentpier_workspace", "*__*"])
        assert.ok(!readerJob.payload.toolsAllow.includes(tool), `${name} has no ${tool}`);
      const done = await until(
        () => {
          const now = hooks.events.get(started.id);
          return ["done", "failed"].includes(now.status) && now;
        },
        90000,
        `the ${name} event did not settle`,
      );
      assert.equal(done.status, "done", `${name} settled`);
      const answered = model.requests
        .slice(from)
        .filter((r) => json(r.messages).includes(readMarker) && stepped(r))
        .at(-1);
      const result = answered?.messages.filter((m) => m.role === "tool").at(-1);
      return { event: started, text: content(result) || json(result?.content ?? "") };
    };
    const closed = await readThrough("Reader", { notify: false, memory: true }, "s-1");
    t.diagnostic(`read without Secrets=${json(closed.text.slice(0, 300))}`);
    assert.equal(closed.event.secretsRead, false);
    assert.equal(closed.event.secretsWithheld, undefined, "no shell: the file stays");
    assert.match(closed.text, /secrets are not available in this run/);
    assert.doesNotMatch(closed.text, /CONTRACT_TOKEN/);
    assert.equal(fs.readFileSync(secretsFile, "utf8"), seeded, "the file stayed");
    const open = await readThrough(
      "Vault",
      { notify: false, memory: true, secrets: true },
      "s-2",
    );
    t.diagnostic(`read with Secrets=${json(open.text.slice(0, 300))}`);
    assert.equal(open.event.secretsRead, true);
    assert.match(open.text, /# Managed by AgentPier\./, "a hook with Secrets reads it");
    assert.match(open.text, /CONTRACT_TOKEN='/);
  },
);
