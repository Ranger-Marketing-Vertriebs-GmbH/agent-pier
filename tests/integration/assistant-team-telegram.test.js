import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { saveText } from "../../server/features/assistants/team-texts.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
function setup(t, options) {
  const f = channelFixture(t, options);
  f.assistants.models = { resolve: async () => ({ release() {} }) };
  f.assistants.teams = new TeamService({ assistants: f.assistants, autoStart: false });
  t.after(() => f.assistants.teams.close());
  const original = f.assistants.send;
  f.assistants.send = async (id, input, context) => {
    const sent = await original(id, input);
    f.assistants.teams.store.recordContext(sent.request.id, {
      ...context,
      teamAllowed: input.teamAllowed === true,
    });
    return sent;
  };
  const sends = [];
  f.client.call = async (method, input) => {
    sends.push({ method, input });
    return method === "sendMessage"
      ? { message_id: sends.length, chat: { id: 42 } }
      : true;
  };
  return {
    ...f,
    sends,
    async proposal(
      members = [{ name: "Planner", role: "Plan", assignment: "Make a plan" }],
    ) {
      await f.service.ingress.receive(f.channel.id, [
        telegramMessage(1, "Plan something"),
      ]);
      await f.service.ingress.dispatch(f.channel.id);
      const entry = f.service.ledger.list(f.channel.id)[0];
      f.service.ledger.patch(entry.id, { state: "delivered" });
      const p = await f.assistants.teams.propose(
        { attemptId: entry.attemptId, toolCallId: "call", assertCurrent() {} },
        {
          objective: "Plan",
          members,
        },
      );
      return f.assistants.teams.store.get(p.id);
    },
  };
}
const callback = (handle, user = 42) => ({
  update_id: 2,
  callback_query: {
    id: "callback",
    data: handle,
    from: { id: user, is_bot: false },
    message: { message_id: 10, chat: { id: 42, type: "private" } },
  },
});
test("late proposal uses separate outbox; paired callback approves exactly once", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  await f.service.teamOutbox.transfer();
  const entry = f.service.outbox.pending(f.channel.id)[0];
  assert.equal(entry.kind, "team-approval");
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  const approve = f.sends[0].input.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(!approve.includes(p.id));
  await f.service.ingress.receive(f.channel.id, [callback(approve, 43)]);
  assert.equal(f.assistants.teams.store.get(p.id).phase, "awaiting_approval");
  await f.service.ingress.receive(f.channel.id, [callback(approve)]);
  await f.service.ingress.receive(f.channel.id, [callback(approve)]);
  assert.equal(f.assistants.teams.store.members(p.id).length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.service.ledger.list(f.channel.id).length, 1);
});
test("completed synthesis arrives after inbox delivery and unknown notification is never automatically resent", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  const teams = f.assistants.teams.store;
  f.assistants.ledger.transition(p.parentAttemptId, "completed");
  const result = await f.assistants.send(
    p.parentConversationId,
    { clientRequestId: `team-result:${p.id}`, text: "Synthesis" },
    { kind: "team-result" },
  );
  f.assistants.ledger.transition(result.attempt.id, "completed");
  teams.write(teams.get(p.id), {
    phase: "completed",
    resultState: "completed",
    resultAttemptId: result.attempt.id,
    resultBatch: [],
  });
  f.assistants.history = async () => ({
    stale: false,
    messages: [
      { role: "assistant", runId: result.attempt.id, text: "Final team result" },
    ],
  });
  await f.service.teamOutbox.transfer();
  await f.service.teamOutbox.transfer();
  assert.equal(f.service.outbox.pending(f.channel.id).length, 1);
  let sends = 0;
  f.client.call = async () => {
    sends++;
    throw Error("lost acknowledgement");
  };
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(sends, 1);
  assert.equal(f.service.outbox.pending(f.channel.id)[0].state, "delivery_uncertain");
});
test("pause preserves notifications, source changes block them and re-pair cannot discard them", async (t) => {
  const f = setup(t);
  await f.proposal();
  await f.service.teamOutbox.transfer();
  await f.service.update(f.channel.id, {
    revision: f.service.store.get(f.channel.id).revision,
    enabled: false,
  });
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(f.sends.length, 0);
  await assert.rejects(
    f.service.pair(f.channel.id, f.service.store.get(f.channel.id).revision),
    { status: 409 },
  );
  const channel = f.service.store.get(f.channel.id);
  f.service.store.write(
    { ...channel, enabled: true, chatId: "43", userId: "43" },
    channel.revision,
  );
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(f.sends.length, 0);
  assert.equal(
    f.service.outbox.pending(f.channel.id)[0].diagnostic,
    "CHANNEL_DESTINATION_CHANGED",
  );
});
for (const kind of ["command", "forwarded", "voice"])
  test(`${kind} intake preserves explicit one-turn authority`, async (t) => {
    const f = setup(t),
      update = telegramMessage(1, "/team Plan this");
    if (kind === "forwarded") update.message.forward_origin = { type: "user" };
    if (kind === "voice") {
      delete update.message.text;
      update.message.voice = { file_id: "v", duration: 1 };
    }
    await f.service.ingress.receive(f.channel.id, [update]);
    if (kind === "voice") {
      const entry = f.service.ledger.list(f.channel.id)[0];
      f.service.ledger.patch(entry.id, { state: "queued", text: "/team Plan this" });
    }
    await f.service.ingress.dispatch(f.channel.id);
    const entry = f.service.ledger.list(f.channel.id)[0],
      ctx = f.assistants.teams.store.context(entry.requestId);
    assert.equal(ctx.kind, "telegram");
    assert.equal(ctx.teamAllowed, kind === "command");
    assert.equal(ctx.chatId, "42");
  });
test("a UI decision invalidates unsent buttons and stale callbacks never change the decision", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  await f.service.teamOutbox.transfer();
  const e = f.service.outbox.pending(f.channel.id)[0];
  f.assistants.teams.decide(
    p.id,
    { revision: p.revision, decision: "decline" },
    { kind: "owner" },
  );
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(f.sends.length, 0);
  assert.equal(f.service.outbox.get(e.id).state, "reviewed");
  await f.service.ingress.receive(f.channel.id, [callback(e.actions[0].handle)]);
  assert.equal(f.assistants.teams.store.get(p.id).phase, "declined");
});
test("pair acceptance cannot bypass outstanding notification recovery", async (t) => {
  const f = setup(t);
  const pair = f.service.store.pairing(
    f.channel.id,
    f.service.store.get(f.channel.id).revision,
  );
  f.service.outbox.enqueue({
    key: "future",
    source: { channelId: f.channel.id, chatId: "42", userId: "42" },
    kind: "team-result",
    text: "Old result",
  });
  assert.equal(
    f.service.store.acceptPair(f.channel.id, {
      chat: { id: 43, type: "private" },
      from: { id: 43, is_bot: false },
      text: `/start ${pair.code}`,
    }),
    false,
  );
});
for (const decision of ["approve", "decline"])
  test(`Telegram ${decision} has immediate feedback and one durable confirmation`, async (t) => {
    const f = setup(t),
      p = await f.proposal();
    await f.service.teamOutbox.transfer();
    const e = f.service.outbox.pending(f.channel.id)[0];
    await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
    const action = e.actions.find((a) => a.decision === decision);
    await f.service.ingress.receive(f.channel.id, [callback(action.handle)]);
    const answer = f.sends.find((s) => s.method === "answerCallbackQuery");
    assert.ok(answer.input.text?.length, "a tap must visibly acknowledge its outcome");
    await f.service.teamOutbox.transfer();
    await f.service.ingress.receive(f.channel.id, [callback(action.handle)]);
    await f.service.teamOutbox.transfer();
    const notifications = f.service.outbox
      .all(f.channel.id)
      .filter((n) => n.kind === "team-decision");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].teamId, p.id);
    assert.match(
      notifications[0].text,
      decision === "approve" ? /freigegeben/ : /abgelehnt/,
    );
    await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
    assert.equal(f.service.outbox.get(notifications[0].id).state, "delivered");
    assert.ok(
      f.sends
        .filter((s) => s.method === "answerCallbackQuery")
        .at(-1)
        .input.text.includes("bereits"),
    );
  });
test("rejected approval cannot produce a success acknowledgement or durable success", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  await f.service.teamOutbox.transfer();
  const e = f.service.outbox.pending(f.channel.id)[0];
  f.assistants.teams.decide(
    p.id,
    { revision: p.revision, decision: "decline" },
    { kind: "owner" },
  );
  await f.service.ingress.receive(f.channel.id, [callback(e.actions[0].handle)]);
  const answer = f.sends.find((s) => s.method === "answerCallbackQuery");
  assert.ok(answer.input.text?.includes("bereits"));
  await f.service.teamOutbox.transfer();
  const confirmation = f.service.outbox
    .all(f.channel.id)
    .find((n) => n.kind === "team-decision");
  assert.match(confirmation.text, /abgelehnt/);
});
test("team work is announced once only after a member starts", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  f.assistants.teams.decide(
    p.id,
    { revision: p.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.service.teamOutbox.transfer();
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
  const store = f.assistants.teams.store,
    member = store.members(p.id)[0];
  store.write(member, { phase: "running" });
  await f.service.teamOutbox.transfer();
  await f.service.teamOutbox.transfer();
  const notices = f.service.outbox.all(f.channel.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "team-started");
  assert.match(notices[0].text, /1 von 1/);
  assert.match(notices[0].text, /Plan/);
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.outbox.get(notices[0].id).state, "delivered");
});
test("a lost callback acknowledgement still leaves a durable decision confirmation", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  await f.service.teamOutbox.transfer();
  const entry = f.service.outbox.pending(f.channel.id)[0];
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  f.client.call = async () => {
    throw Error("acknowledgement lost");
  };
  await f.service.ingress.receive(f.channel.id, [callback(entry.actions[0].handle)]);
  await f.service.teamOutbox.transfer();
  assert.equal(f.assistants.teams.store.get(p.id).authorization.kind, "approval");
  assert.equal(f.service.outbox.pending(f.channel.id)[0].kind, "team-decision");
});
test("already transferred results never gain retrospective decision or start notices", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  await f.service.teamOutbox.transfer();
  f.assistants.teams.decide(
    p.id,
    { revision: p.revision, decision: "approve" },
    { kind: "owner" },
  );
  f.service.teamOutbox.recordTransfer(`result:${p.id}`, "old-result");
  await f.service.teamOutbox.transfer();
  assert.deepEqual(
    f.service.outbox.all(f.channel.id).map((n) => n.kind),
    ["team-approval"],
  );
});
test("a start notification survives a crash before transfer bookkeeping without duplication", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  const store = f.assistants.teams.store;
  f.assistants.teams.decide(
    p.id,
    { revision: p.revision, decision: "approve" },
    { kind: "owner" },
  );
  store.write(store.members(p.id)[0], { phase: "running" });
  await f.service.teamOutbox.transfer();
  const original = f.service.outbox.all(f.channel.id)[0];
  store.db
    .prepare("DELETE FROM assistant_team_records WHERE id=?")
    .run(`notification:started:${p.id}`);
  store.write(store.get(p.id), { objective: "Updated objective after enqueue" });
  await f.service.teamOutbox.transfer();
  assert.deepEqual(f.service.outbox.all(f.channel.id), [original]);
  assert.equal(store.get(`notification:started:${p.id}`).outboxId, original.id);
});
test("uncertain and provisioning members do not announce active work", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  const store = f.assistants.teams.store;
  f.assistants.teams.decide(
    p.id,
    { revision: p.revision, decision: "approve" },
    { kind: "owner" },
  );
  for (const phase of ["provisioning", "uncertain", "completed"]) {
    store.write(store.members(p.id)[0], { phase });
    await f.service.teamOutbox.transfer();
  }
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
});
test("a transcribed owner voice request starts a team; a forwarded one never does", async (t) => {
  const f = setup(t);
  const teams = f.assistants.teams;
  const voice = async (updateId, transcript, forwarded) => {
    const update = telegramMessage(updateId, undefined);
    delete update.message.text;
    update.message.voice = { file_id: `voice-${updateId}`, duration: 3 };
    if (forwarded) update.message.forward_origin = { type: "hidden_user", date: 1 };
    await f.service.ingress.receive(f.channel.id, [update]);
    const entry = f.service.ledger
      .list(f.channel.id)
      .find((e) => e.updateId === updateId);
    // Speech recognition stores the transcript before dispatch.
    f.service.ledger.patch(entry.id, { text: transcript, state: "queued" });
    await f.service.ingress.dispatch(f.channel.id);
    const sent = f.service.ledger.get(entry.id);
    const p = await teams.propose(
      { attemptId: sent.attemptId, toolCallId: `call-${updateId}`, assertCurrent() {} },
      {
        objective: "Sort invoices",
        members: [{ name: "Sorter", role: "Sort", assignment: "Sort the invoices" }],
        ownerRequestedTeam: true,
        ownerRequestQuote: "build a team",
      },
    );
    const record = teams.store.get(p.id);
    if (!record.authorization) teams.store.write(record, { phase: "declined" });
    f.assistants.ledger.transition(sent.attemptId, "completed");
    f.service.ledger.patch(entry.id, { state: "delivered" });
    return record;
  };
  const forwarded = await voice(5, "Please build a team that sorts my invoices", true);
  assert.equal(forwarded.authorization, null);
  assert.equal(forwarded.phase, "awaiting_approval");
  const owner = await voice(6, "Please build a team that sorts my invoices", false);
  assert.equal(owner.authorization.kind, "task");
  assert.equal(owner.authorization.source, "ownerRequest");
  assert.equal(teams.store.policy(owner.parentAssistantId).autonomous, false);
  for (const m of teams.store.members(owner.id))
    teams.store.write(m, { phase: "running" });
  await f.service.teamOutbox.transfer();
  const started = f.service.outbox
    .all(f.channel.id)
    .find((e) => e.key === `team-started:${owner.id}`);
  assert.match(started.text, /Gestartet, weil du geschrieben hast: „build a team“$/);
});
for (const [language, heading, marker] of [
  ["de", "MCP-Server: ", "(stdio, lokaler Befehl)"],
  ["en", "MCP servers: ", "(stdio, local command)"],
])
  test(`the ${language} approval lists each member's MCP servers and marks stdio`, async (t) => {
    const f = setup(t, { language: () => language });
    const servers = new McpServerStore({
      dataDir: f.dataDir,
      pathEnv: "/fake/bin",
      exists: (file) => file === "/abs/files",
    });
    t.after(() => servers.close());
    f.assistants.mcp = { servers };
    const github = servers.create({
      name: "github",
      transport: "http",
      url: "https://mcp.example.test/v1?key=secret-query",
      headers: { Authorization: "Bearer secret-token" },
    });
    const files = servers.create({
      name: "files",
      transport: "stdio",
      command: "/abs/files",
      args: ["--root", "/private/data"],
      env: { FILES_TOKEN: "secret-env" },
    });
    servers.setBindings("agent", f.channel.assistantId, [github.id, files.id]);
    await f.proposal([
      {
        name: "Planner",
        role: "Plan",
        assignment: "Make a plan",
        mcpServers: ["github"],
      },
      {
        name: "Writer",
        role: "Write",
        assignment: "Write it",
        mcpServers: ["files", "github"],
      },
      { name: "Critic", role: "Review", assignment: "Review it" },
    ]);
    await f.service.teamOutbox.transfer();
    const { text } = f.service.outbox.pending(f.channel.id)[0];
    const [, planner, writer, critic] = text.split("\n\n");
    assert.equal(planner.split("\n").at(-1), `${heading}github`);
    assert.equal(writer.split("\n").at(-1), `${heading}files ${marker}, github`);
    assert.ok(!critic.includes(heading.trim()));
    for (const secret of ["secret", "mcp.example.test", "/abs/files", "/private/data"])
      assert.ok(!text.includes(secret), secret);
  });

test("an unreadable server list is shown as unavailable and only declining is offered", async (t) => {
  const f = setup(t, { language: () => "en" });
  const servers = new McpServerStore({ dataDir: f.dataDir, pathEnv: "/fake/bin" });
  t.after(() => servers.close());
  f.assistants.mcp = { servers };
  const github = servers.create({
    name: "github",
    transport: "http",
    url: "https://g.test/",
  });
  servers.setBindings("agent", f.channel.assistantId, [github.id]);
  await f.proposal([
    { name: "Planner", role: "Plan", assignment: "Plan", mcpServers: ["github"] },
  ]);
  servers.list = () => {
    throw Error("SQLITE_IOERR");
  };
  await f.service.teamOutbox.transfer();
  const [entry] = f.service.outbox.pending(f.channel.id);
  assert.match(entry.text, /MCP servers: the list cannot be read right now/);
  assert.deepEqual(
    entry.actions.map((a) => a.decision),
    ["decline"],
  );
  const team = f.assistants.teams.store.list()[0];
  assert.throws(
    () =>
      f.assistants.teams.decide(
        team.id,
        { revision: team.revision, decision: "approve" },
        { kind: "owner", channel: "ui" },
      ),
    { status: 503, key: "teamMcpServersUnavailable" },
  );
  assert.equal(f.assistants.teams.store.get(team.id).phase, "awaiting_approval");
  const shown = f.assistants.teams.list().teams[0].members[0];
  assert.equal(shown.mcpServersUnavailable, true);
  assert.equal(shown.mcpServers, undefined);
});
test("a long team synthesis is read whole on Telegram, or ends with the incomplete note", async (t) => {
  // The fixture channel speaks German.
  for (const [alone, expected] of [
    [(text) => text, (text) => text],
    [
      () => "[chat.history omitted: message too large]",
      (text) =>
        `${text.slice(0, 8000).trimEnd()}\n\nAntwort gekürzt – der Rest konnte nicht gesendet werden.`,
    ],
  ]) {
    const f = setup(t),
      p = await f.proposal();
    const teams = f.assistants.teams.store;
    f.assistants.ledger.transition(p.parentAttemptId, "completed");
    const result = await f.assistants.send(
      p.parentConversationId,
      { clientRequestId: `team-result:${p.id}`, text: "Synthesis" },
      { kind: "team-result" },
    );
    f.assistants.ledger.transition(result.attempt.id, "completed");
    teams.write(teams.get(p.id), {
      phase: "completed",
      resultState: "completed",
      resultAttemptId: result.attempt.id,
      resultBatch: [],
    });
    // Longer than the history page serves; its own read is still due.
    const full = `Team result: ${"the plan, in detail. ".repeat(600)}`;
    f.assistants.history = async () => ({
      stale: false,
      messages: [
        {
          id: "synthesis-1",
          role: "assistant",
          runId: result.attempt.id,
          text: full.slice(0, 8000),
          partial: true,
        },
      ],
    });
    const asked = [];
    f.assistants.message = async (conversationId, messageId) => {
      asked.push([conversationId, messageId]);
      return alone(full);
    };
    await f.service.teamOutbox.transfer();
    const notice = f.service.outbox
      .pending(f.channel.id)
      .find((e) => e.kind === "team-result");
    assert.deepEqual(asked, [[p.parentConversationId, "synthesis-1"]]);
    assert.equal(notice.text, expected(full));
  }
});
test("a refused synthesis still sends the members' reports to Telegram", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  const teams = f.assistants.teams.store;
  teams.write(teams.get(p.id), {
    phase: "completed",
    resultState: "unsent",
    resultDiagnostic: "RESULT_UNSENDABLE",
    resultBatch: [
      { name: "Planner", role: "Plan", phase: "completed", text: "The plan", cut: true },
    ],
  });
  await f.service.teamOutbox.transfer();
  const notice = f.service.outbox
    .pending(f.channel.id)
    .find((e) => e.kind === "team-result");
  assert.ok(notice.text.includes("The plan"));
  assert.ok(notice.text.includes("Bericht gekürzt"));
});

test("the Telegram fallback reads each whole report, or marks one whose row is gone", async (t) => {
  const f = setup(t),
    p = await f.proposal();
  const teams = f.assistants.teams.store;
  const whole = `The plan: ${"step, ".repeat(600)}done.`;
  saveText(teams.db, p.id, "planner", whole);
  teams.write(teams.get(p.id), {
    phase: "completed",
    resultState: "unsent",
    resultDiagnostic: "RESULT_UNSENDABLE",
    resultBatch: [
      { memberId: "planner", name: "Planner", role: "Plan", phase: "completed" },
      { memberId: "writer", name: "Writer", role: "Write", phase: "completed" },
    ].map((m) => ({ ...m, text: "Excerpt", truncated: true })),
  });
  await f.service.teamOutbox.transfer();
  const notice = f.service.outbox
    .pending(f.channel.id)
    .find((e) => e.kind === "team-result");
  assert.ok(notice.text.includes(whole));
  // Only the writer's excerpt is left: it is marked shortened.
  assert.ok(
    notice.text.endsWith("Excerpt\nBericht gekürzt – vollständig im Chat des Mitglieds."),
  );
});
