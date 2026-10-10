import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { assistantTeamRoutes } from "../../server/http/routes/assistant-teams.js";
import { assistantWorkflowRoutes } from "../../server/http/routes/assistant-workflows.js";

const decisions = (audit) =>
  audit
    .export()
    .filter((e) => e.action === "assistant.answered")
    .map(({ outcome, resourceId, source, details }) => ({
      outcome,
      resourceId,
      source,
      ...details,
    }));

async function serve(t, router) {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (route, body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

function teams(t) {
  const f = channelFixture(t);
  const audit = new AuditStore({ dataDir: f.dataDir });
  t.after(() => audit.db.close());
  f.assistants.models = { resolve: async () => ({ release() {} }) };
  f.assistants.teams = new TeamService({
    assistants: f.assistants,
    autoStart: false,
    audit,
  });
  t.after(() => f.assistants.teams.close());
  const original = f.assistants.send;
  f.assistants.send = async (id, input, context) => {
    const sent = await original(id, input);
    f.assistants.teams.store.recordContext(sent.request.id, { ...context });
    return sent;
  };
  const sends = [];
  f.client.call = async (method, input) => {
    sends.push({ method, input });
    return method === "sendMessage"
      ? { message_id: sends.length, chat: { id: 42 } }
      : true;
  };
  let turn = 0;
  async function proposal() {
    await f.service.ingress.receive(f.channel.id, [
      telegramMessage(++turn, `Plan ${turn}`),
    ]);
    await f.service.ingress.dispatch(f.channel.id);
    const entry = f.service.ledger.list(f.channel.id).at(-1);
    f.service.ledger.patch(entry.id, { state: "delivered" });
    const p = await f.assistants.teams.propose(
      { attemptId: entry.attemptId, toolCallId: `call-${turn}`, assertCurrent() {} },
      {
        objective: "Plan",
        members: [{ name: "Planner", role: "Plan", assignment: "Make a plan" }],
      },
    );
    f.assistants.ledger.transition(entry.attemptId, "completed");
    return f.assistants.teams.store.get(p.id);
  }
  return { ...f, audit, sends, proposal };
}

test("Telegram and AgentPier team decisions each leave an attributed audit record", async (t) => {
  const f = teams(t);
  const first = await f.proposal();
  await f.service.teamOutbox.transfer();
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  const decline = f.service.outbox
    .all(f.channel.id)
    .flatMap((e) => e.actions || [])
    .find((a) => a.decision === "decline").handle;
  await f.service.ingress.receive(f.channel.id, [
    {
      update_id: 90,
      callback_query: {
        id: "callback",
        data: decline,
        from: { id: 42, is_bot: false },
        message: { message_id: 10, chat: { id: 42, type: "private" } },
      },
    },
  ]);
  assert.equal(f.assistants.teams.store.get(first.id).phase, "declined");
  const second = await f.proposal();
  const post = await serve(t, assistantTeamRoutes({ assistants: f.assistants }));
  const route = `/assistant-team-proposals/${second.id}/decision`;
  assert.equal(
    (await post(route, { revision: second.revision, decision: "approve" })).status,
    200,
  );
  assert.equal(
    (await post(route, { revision: second.revision, decision: "decline" })).status,
    409,
  );
  const parent = f.channel.assistantId;
  assert.deepEqual(decisions(f.audit), [
    {
      outcome: "success",
      resourceId: parent,
      source: "user",
      actor: "owner",
      channel: "telegram",
      actionId: first.id,
      decision: "decline",
      revision: first.revision,
      kind: "team",
    },
    {
      outcome: "success",
      resourceId: parent,
      source: "user",
      actor: "owner",
      channel: "ui",
      actionId: second.id,
      decision: "approve",
      revision: second.revision,
      kind: "team",
    },
    {
      outcome: "failure",
      resourceId: parent,
      source: "user",
      actor: "owner",
      channel: "ui",
      actionId: second.id,
      decision: "decline",
      revision: second.revision,
      kind: "team",
    },
  ]);
});

test("a parent withdrawing its own proposal is audited as the assistant, not the owner", async (t) => {
  const f = teams(t);
  const p = await f.proposal();
  const sent = await f.assistants.send(
    f.channel.conversationId,
    { clientRequestId: "stop", text: "Stop" },
    { kind: "owner" },
  );
  await f.assistants.teams.stop(
    { attemptId: sent.attempt.id, toolCallId: "stop", assertCurrent() {} },
    { teamId: p.id },
  );
  assert.deepEqual(
    decisions(f.audit).map(({ actor, channel, source, decision }) => ({
      actor,
      channel,
      source,
      decision,
    })),
    [{ actor: "assistant", channel: "tool", source: "system", decision: "decline" }],
  );
});

test("workflow action decisions from AgentPier and Telegram are audited", async (t) => {
  const f = await workflowFixture(t);
  const audit = new AuditStore({ dataDir: f.dataDir });
  t.after(() => audit.db.close());
  f.services.audit = audit;
  f.workflows.access.save(f.id, f.policy, 0);
  const telegram = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
  };
  const propose = async (origin) =>
    f.workflows.invoke(await f.invocation(crypto.randomUUID(), origin), {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Build it",
    });
  const viaUi = await propose({ kind: "owner" });
  const viaTelegram = await propose(telegram);
  assert.equal(viaUi.state, "awaiting_approval");
  const post = await serve(t, assistantWorkflowRoutes({ assistants: f.assistants }));
  const routes = await post(`/assistant-actions/${viaUi.id}/decision`, {
    revision: viaUi.revision,
    decision: "decline",
  });
  assert.equal(routes.status, 200);
  await f.workflows.decide(
    viaTelegram.id,
    { revision: viaTelegram.revision, decision: "approve" },
    telegram,
  );
  assert.deepEqual(
    decisions(audit).map(({ channel, actionId, decision, revision, kind, outcome }) => ({
      channel,
      actionId,
      decision,
      revision,
      kind,
      outcome,
    })),
    [
      {
        channel: "ui",
        actionId: viaUi.id,
        decision: "decline",
        revision: viaUi.revision,
        kind: "action",
        outcome: "success",
      },
      {
        channel: "telegram",
        actionId: viaTelegram.id,
        decision: "approve",
        revision: viaTelegram.revision,
        kind: "action",
        outcome: "success",
      },
    ],
  );
});

test("a failing audit write never reports a committed decision as failed", async (t) => {
  const f = teams(t);
  const p = await f.proposal();
  f.assistants.teams.audit = {
    append() {
      throw Error("audit disk full");
    },
  };
  const logged = t.mock.method(console, "error", () => {});
  const result = f.assistants.teams.decide(
    p.id,
    { revision: p.revision, decision: "decline" },
    { kind: "owner", channel: "ui" },
  );
  assert.equal(result.phase, "declined");
  assert.equal(f.assistants.teams.store.get(p.id).phase, "declined");
  assert.equal(logged.mock.callCount(), 1);
  assert.throws(
    () =>
      f.assistants.teams.decide(
        p.id,
        { revision: p.revision, decision: "approve" },
        { kind: "owner", channel: "ui" },
      ),
    { status: 409 },
    "the rejected decision's own error stays authoritative",
  );
});
