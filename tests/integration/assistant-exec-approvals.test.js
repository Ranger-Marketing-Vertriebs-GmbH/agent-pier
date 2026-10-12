import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { ExecApprovals } from "../../server/features/assistants/exec-approvals.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an exec request from a Telegram run waits in the workflow and ends with the Gateway", async (t) => {
  const f = await workflowFixture(t);
  const agent = f.store.getAssistant(f.id);
  f.store.updateAssistant(f.id, { shell: "approval" }, agent.revision);
  const emitter = new EventEmitter();
  const client = {
    ready: true,
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      return [];
    },
    subscribe(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
  const emit = (event, payload) => emitter.emit("event", { event, payload });
  f.assistants.runtime.client = client;
  f.assistants.gatewayEvents = new GatewayEventHub();
  f.assistants.gatewayEvents.bind(client);
  new ExecApprovals(f.workflows, { log: () => {} });

  const origin = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  };
  const inv = await f.invocation("exec-turn", origin);
  emit("exec.approval.requested", {
    id: "approval-1",
    request: {
      command: "git status",
      cwd: "/work",
      agentId: agent.runtimeAgentId,
      sessionKey: "session",
      runId: inv.attemptId,
      allowedDecisions: ["allow-once", "deny"],
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 1800000,
  });
  await settle();
  const [listed] = f.workflows.list(f.id).actions;
  assert.equal(listed.state, "awaiting_approval");
  assert.equal(listed.payload.action, "exec");
  assert.deepEqual(listed.payload.allowedDecisions, ["allow-once", "deny"]);

  await f.workflows.tick();
  await f.workflows.tick();
  const [approval] = f.service.outbox.all();
  assert.equal(approval.kind, "action-approval");
  assert.equal(approval.chatId, "42");
  assert.match(approval.text, /git status/);
  assert.match(approval.text, /\/work/);
  assert.deepEqual(
    approval.actions.map((a) => a.decision),
    ["allow-once", "allow-always", "deny"],
  );
  // Coding decisions never answer an exec approval.
  await assert.rejects(
    f.workflows.decide(
      listed.id,
      { revision: listed.revision, decision: "approve" },
      origin,
    ),
    { status: 400 },
  );

  emit("exec.approval.resolved", {
    id: "approval-1",
    decision: "allow-once",
    resolvedBy: "web",
    ts: Date.now(),
  });
  await settle();
  await f.workflows.tick();
  const done = f.workflows.get(listed.id);
  assert.equal(done.state, "completed");
  assert.deepEqual(done.result, { decision: "allow-once" });
  assert.equal(done.settled, true);
  assert.equal(
    f.service.outbox.all().filter((e) => e.kind === "action-result").length,
    1,
  );
  assert.deepEqual(client.calls, []);
});
