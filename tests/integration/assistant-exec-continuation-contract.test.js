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
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { HeartbeatRuns } from "../../server/features/assistants/exec-continuation.js";
import { completedProcesses } from "../../server/features/assistants/team-plugin/exec-processes.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

// AGENTPIER-185 against the pinned Gateway: an owner turn starts a background exec
// and ends; when the command exits, OpenClaw's completion run in the same session
// writes with that turn's rights (exec-continuation.js). The same completion after a
// newer forwarded request, or outside the window, stays refused. This pins what the
// implementation assumes of OpenClaw: the completion's raw transcript entry
// (`sessions.get`: provenance, the owner turn's idempotency key, the background
// exec's `sessionId` and the completion's process list), the
// `isHeartbeat` agent events of its run, the hook's run id and the session it runs in.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const long = { timeoutMs: 60000 };
// The turn's own message: OpenClaw adds a runtime context message (the active exec
// sessions) to the model's prompt while a background command runs.
const turnMessage = (m) =>
  m.role === "user" && !JSON.stringify(m.content).includes("OpenClaw runtime context");
const lastUser = (request) =>
  request.messages.slice(request.messages.findLastIndex(turnMessage));
// The completion run's prompt to the model ("An async command you ran earlier has
// completed ..."); its transcript entry is "[OpenClaw exec completion]".
const isCompletion = (request) =>
  /async command/i.test(JSON.stringify(lastUser(request)[0]));

test(
  "pinned Gateway: an exec completion continues its owner turn's writes",
  { skip: !installed, timeout: contractTimeout(300000) },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, model, bridge, clock;
    t.after(async () => {
      await runtime?.close();
      await bridge?.close();
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
    // The owner turn starts a background command; each completion writes one note.
    let note = "after";
    model.reply = (request) => {
      // A summary request (OpenClaw's compaction) gets a summary.
      if (JSON.stringify(lastUser(request)[0]).includes("<conversation>"))
        return { text: "Summary." };
      const done = lastUser(request).some((m) => m.role === "tool");
      if (isCompletion(request))
        return done
          ? { text: "Saved." }
          : note === "workspace"
            ? { tool: { name: "agentpier_workspace", arguments: { action: "catalog" } } }
            : {
                tool: {
                  name: "write",
                  arguments: { path: `notes/${note}.md`, content: "AFTER\n" },
                },
              };
      const asked = JSON.stringify(lastUser(request)[0]);
      const steps = lastUser(request).filter((m) => m.role === "tool").length;
      // "List" runs a foreground command; "foreign" starts another background one.
      // "Render" first makes an exec call that fails argument validation (OpenClaw
      // refuses it before anything starts) and a foreground one that exits 3;
      // "NODEHOST" one whose host fails after the call began; "BLOCKONE" one that a
      // before_tool_call hook blocks; all then background their command. "DETACH"
      // backgrounds a shell that exits at once while its child keeps the output.
      const background = { command: "sleep 4; echo RENDERED", background: true };
      const plan = asked.includes("List")
        ? [{ command: "echo LISTED" }]
        : asked.includes("foreign")
          ? [{ command: "sleep 6; echo FOREIGN", background: true }]
          : asked.includes("NODEHOST")
            ? [{ command: "echo HOST", host: "node" }, background]
            : asked.includes("BLOCKONE")
              ? [{ command: "echo BLOCKED" }, background]
              : asked.includes("DETACH")
                ? [{ command: "(sleep 8; echo LATE) & echo STARTED", background: true }]
                : [{}, { command: "echo FAILING; exit 3" }, background];
      return steps < plan.length
        ? { tool: { name: "exec", arguments: plan[steps] } }
        : { text: "Started." };
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
    const heartbeatRuns = new HeartbeatRuns(),
      gatewayEvents = new GatewayEventHub(),
      events = [];
    f.assistants.heartbeatRuns = heartbeatRuns;
    gatewayEvents.on("agent", (payload) => {
      events.push(payload);
      heartbeatRuns.observe(payload);
    });
    const contexts = new Map();
    bridge = new TeamBridge({
      assistants: f.assistants,
      generation: () => runtime.generation,
      teams: { store: { context: (requestId) => contexts.get(requestId) || null } },
      now: () => (clock ?? Date.now)(),
    });
    // Every write decision with the hook's run id.
    const decisions = [];
    const decide = bridge.toolPolicy.bind(bridge);
    // Armed, the next exec call is blocked by the plugin's own locked-tool hook.
    let blockExec = false;
    bridge.toolPolicy = (input) => {
      if (input.toolName === "exec" && blockExec) {
        blockExec = false;
        return { allow: false };
      }
      const settle = (result) => {
        decisions.push({ ...input, allow: result.allow });
        return result;
      };
      const result = decide(input);
      return result instanceof Promise ? result.then(settle) : settle(result);
    };
    // Every workspace ticket the completion run asks for, with its outcome.
    const prepared = [];
    const prepare = bridge.prepare.bind(bridge);
    bridge.prepare = (input) => {
      try {
        const ticket = prepare(input);
        prepared.push({ ...input, bound: true });
        return ticket;
      } catch (error) {
        prepared.push({ ...input, bound: false });
        throw error;
      }
    };
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "exec-continuation-fixture" },
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
    // As AgentPier does for every chat (conversation-open.js). The completion run is
    // not visible to the Control UI: its agent events reach only these subscribers.
    await runtime.client.call("sessions.messages.subscribe", { key: session.key }, long);
    const conversation = f.store.getConversation(f.channel.conversationId);
    f.store.db
      .prepare("UPDATE conversations SET session_key=?, body=? WHERE id=?")
      .run(
        session.key,
        JSON.stringify({ ...conversation, runtimeSessionKey: session.key }),
        conversation.id,
      );

    // An owner turn as AgentPier sends it: the attempt id is the idempotency key.
    const ownerTurn = async (text, context = { kind: "owner" }) => {
      const request = f.assistants.ledger.accept(conversation.id, {
        clientRequestId: randomUUID(),
        text,
      });
      contexts.set(request.id, context);
      const attempt = f.assistants.ledger.recordAttempt(request.id);
      const sent = await runtime.client.call(
        "sessions.send",
        { key: session.key, message: text, idempotencyKey: attempt.id },
        long,
      );
      f.assistants.ledger.transition(attempt.id, "running", { runtimeRunId: sent.runId });
      await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      f.assistants.ledger.transition(attempt.id, "completed");
      return { attempt, runId: sent.runId };
    };
    // The completion run's write decision, once its run has ended.
    const completion = async (from) => {
      const deadline = Date.now() + contractTimeout(60000);
      while (Date.now() < deadline) {
        const write = decisions.slice(from).find((d) => d.toolName === "write");
        const ended =
          write &&
          events.some(
            (e) =>
              e.runId === write.runId &&
              e.stream === "lifecycle" &&
              ["end", "error"].includes(e.data?.phase),
          );
        if (ended) return write;
        await delay(200);
      }
      assert.fail("no completion run wrote within a minute");
    };

    // 1. The owner turn starts the command and ends before it exits.
    const owner = await ownerTurn("Render the video in the background.");
    let from = decisions.length;
    const write = await completion(from);
    const run = events.filter((e) => e.runId === write.runId);
    t.diagnostic(`owner run=${owner.runId} attempt=${owner.attempt.id}`);
    t.diagnostic(`completion hook=${JSON.stringify(write)}`);
    t.diagnostic(
      `completion events=${JSON.stringify(
        run.map((e) => ({
          stream: e.stream,
          phase: e.data?.phase,
          isHeartbeat: e.isHeartbeat,
          sessionKey: e.sessionKey,
        })),
      )}`,
    );
    // Assumptions 2 to 4: heartbeat events, the hook's run id, the chat's own session.
    assert.notEqual(write.runId, owner.runId, "a run of its own");
    assert.ok(run.length, "the completion run's agent events reach AgentPier");
    assert.ok(
      run.some((e) => e.isHeartbeat === true),
      "its events mark it heartbeat-driven",
    );
    assert.equal(write.sessionKey, session.key, "it runs in the chat's session");
    assert.ok(run.every((e) => e.sessionKey === session.key));
    // Assumption 1: the raw transcript names the owner turn and the completion.
    const page = await runtime.client.call(
      "sessions.get",
      { key: session.key, limit: 100 },
      long,
    );
    const users = page.messages
      .filter((m) => m.role === "user")
      .map((m) => ({
        provenance: m.provenance,
        idempotencyKey: m.idempotencyKey ?? m.__openclaw?.idempotencyKey,
        text: JSON.stringify(m.content).slice(0, 120),
      }));
    t.diagnostic(`sessions.get users=${JSON.stringify(users)}`);
    assert.equal(users[0].idempotencyKey, `${owner.attempt.id}:user`);
    assert.deepEqual(users.at(-1).provenance, {
      kind: "internal_system",
      sourceTool: "exec",
      ...(users.at(-1).provenance?.sourceSessionKey !== undefined && {
        sourceSessionKey: users.at(-1).provenance.sourceSessionKey,
      }),
    });
    // The completion names the owner turn's background process (its first eight
    // characters), which the exec result reports as still running.
    const started = page.messages.find(
      (m) => m.toolName === "exec" && m.details?.status === "running",
    ).details;
    const reported = completedProcesses(
      page.messages.findLast((m) => m.role === "user").__openclaw?.modelPromptProjection
        ?.text,
    );
    t.diagnostic(`started=${started.sessionId} reported=${JSON.stringify(reported)}`);
    assert.equal(started.status, "running");
    // The failed calls came before it and left the record complete.
    const failed = page.messages.filter((m) => m.toolName === "exec" && m.isError);
    t.diagnostic(
      `failed execs=${JSON.stringify(failed.map((m) => [m.details, JSON.stringify(m.content).slice(0, 120)]))}`,
    );
    assert.equal(failed.length, 1);
    assert.match(JSON.stringify(failed[0].content), /Validation failed for tool/);
    // The foreground command that exited 3 ends "completed" with its exit code;
    // OpenClaw reports it to after_tool_call as an error (isToolResultError).
    const exited = page.messages.find(
      (m) => m.toolName === "exec" && m.details?.exitCode === 3,
    );
    assert.equal(exited?.details.status, "completed");
    assert.deepEqual(reported, [started.sessionId.slice(0, 8)]);
    // The write itself.
    assert.equal(write.allow, true, "the completion continues the owner turn");
    assert.equal(
      fs.readFileSync(path.join(workspace, "notes/after.md"), "utf8"),
      "AFTER\n",
    );

    // 2. A newer forwarded request: the next completion stays refused.
    await ownerTurn("Render another one.");
    const forwarded = f.assistants.ledger.accept(conversation.id, {
      clientRequestId: randomUUID(),
      text: "Forwarded: render this.",
    });
    contexts.set(forwarded.id, { kind: "telegram", forwarded: true });
    const fwd = f.assistants.ledger.recordAttempt(forwarded.id);
    f.assistants.ledger.transition(fwd.id, "completed");
    note = "after-forwarded";
    from = decisions.length;
    const refused = await completion(from);
    assert.equal(refused.allow, false, "a newer request ends the continuation");
    assert.equal(fs.existsSync(path.join(workspace, "notes/after-forwarded.md")), false);

    // 3. Past the window (the bridge's clock three hours on): refused.
    await ownerTurn("Render a third one.");
    clock = () => Date.now() + 3 * 3600000;
    note = "after-window";
    from = decisions.length;
    const late = await completion(from);
    assert.equal(late.allow, false, "a completion past the window stays refused");
    assert.equal(fs.existsSync(path.join(workspace, "notes/after-window.md")), false);

    // 4. A forwarded turn starts a background command, the owner's later turn runs a
    // foreground one, then the forwarded turn's command completes: refused.
    clock = undefined;
    const forwardedTurn = await ownerTurn("Forwarded: start the foreign job.", {
      kind: "telegram",
      forwarded: true,
    });
    await ownerTurn("List the folder.");
    note = "after-foreign";
    from = decisions.length;
    const foreign = await completion(from);
    const tail = await runtime.client.call("sessions.get", { key: session.key }, long);
    const results = tail.messages
      .filter((m) => m.role === "toolResult" && m.toolName === "exec")
      .slice(-2)
      .map((m) => m.details?.status);
    t.diagnostic(`foreign/owner exec results=${JSON.stringify(results)}`);
    assert.deepEqual(results, ["running", "completed"], "background, then foreground");
    assert.equal(foreign.allow, false, "another turn's command never writes");
    assert.equal(fs.existsSync(path.join(workspace, "notes/after-foreign.md")), false);
    // The Gateway's record names the reported process with the forwarded turn's run.
    t.diagnostic(`foreign evidence=${JSON.stringify(foreign.exec)}`);
    assert.deepEqual(
      foreign.exec.processes.map((p) => [p.id.slice(0, 8), p.runId]),
      [[foreign.exec.completion.ids[0], forwardedTurn.runId]],
    );

    // 5. A completion run's agentpier_workspace call names its run (the plugin maps
    // the tool call to the run of its before_tool_call) and is bound to the turn.
    const fifth = await ownerTurn("Render a fifth one.");
    note = "workspace";
    const deadline = Date.now() + contractTimeout(60000);
    while (!prepared.length && Date.now() < deadline) await delay(200);
    t.diagnostic(`workspace prepare=${JSON.stringify(prepared[0])}`);
    assert.equal(prepared[0]?.action, "workspace");
    assert.equal(typeof prepared[0].runId, "string");
    assert.notEqual(prepared[0].runId, fifth.runId);
    assert.equal(prepared[0].exec.completion.runId, prepared[0].runId);
    assert.equal(prepared[0].bound, true, "the completion's workspace call is bound");

    // 6. A blocked exec call leaves nothing open: the next completion is credited.
    blockExec = true;
    await ownerTurn("BLOCKONE render.");
    assert.equal(blockExec, false, "the exec call was blocked");
    note = "after-blocked";
    from = decisions.length;
    const unblocked = await completion(from);
    t.diagnostic(`blocked evidence=${JSON.stringify(unblocked.exec)}`);
    assert.equal(unblocked.allow, true);

    // 7. A shell that exits at once while its child runs on: its pid is gone, the
    // exec session lives until the output closes, and its completion is credited.
    await ownerTurn("DETACH render.");
    const detached = (
      await runtime.client.call("sessions.get", { key: session.key }, long)
    ).messages.findLast(
      (m) => m.toolName === "exec" && m.details?.status === "running",
    ).details;
    await delay(1000);
    assert.throws(() => process.kill(detached.pid, 0), { code: "ESRCH" });
    note = "after-detach";
    from = decisions.length;
    const afterDetach = await completion(from);
    t.diagnostic(`detached evidence=${JSON.stringify(afterDetach.exec)}`);
    assert.equal(afterDetach.exec.completion.ids[0], detached.sessionId.slice(0, 8));
    assert.equal(afterDetach.allow, true);

    // 8. An exec error OpenClaw does not mark as before the start (a host check that
    // runs inside the call) leaves the session uncertain: its completion is refused.
    await ownerTurn("Render on NODEHOST.");
    note = "after-node";
    from = decisions.length;
    const node = await completion(from);
    t.diagnostic(`node evidence=${JSON.stringify(node.exec)}`);
    assert.equal(node.exec.complete, false);
    assert.equal(node.allow, false);
  },
);
