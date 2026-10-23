import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";

// AGENTPIER-199: on the owner's own direct request the agent switches "May write" on
// its routines with its own tool, as the owner can in the routine's settings. Users,
// scheduled, forwarded and member turns never can.
const schedule = { kind: "cron", expr: "0 8 * * *", tz: "Europe/Berlin" };
const ownerTurn = { kind: "owner" };

function setup(t) {
  const f = routineFixture(t);
  let context = ownerTurn;
  f.assistants.teams = { store: { context: () => context } };
  f.audits = [];
  f.assistants.audit = { append: (event) => f.audits.push(event) };
  let n = 0;
  // One tool call in a turn of the main chat (or `conversationId`) with `origin`;
  // `turn` repeats an earlier call's attempt and tool call id (a replay).
  f.call = async (
    input,
    origin = ownerTurn,
    conversationId = f.channel.conversationId,
    turn,
  ) => {
    context = origin;
    let invocation = turn;
    if (!invocation) {
      const request = f.assistants.ledger.accept(conversationId, {
        clientRequestId: `turn-${++n}`,
        text: "die Routine darf schreiben",
      });
      const attempt = f.assistants.ledger.recordAttempt(request.id);
      invocation = { attemptId: attempt.id, toolCallId: `call-${n}`, assertCurrent() {} };
    }
    f.last = invocation;
    return f.routines.invoke(invocation, input);
  };
  f.create = (extra = {}, origin) =>
    f.call(
      {
        action: "create",
        name: "Cleanup",
        prompt: f.input.prompt,
        trigger: schedule,
        ...extra,
      },
      origin,
    );
  return f;
}

const writesOf = (f, id) => f.reminders.bindings.get(id).routineWrites === true;
const writeAudits = (f) => f.audits.filter((e) => e.details?.kind === "routine-writes");

test("an owner's web-chat turn creates a routine that may write", async (t) => {
  const f = setup(t);
  const routine = await f.create({ writes: true });
  assert.equal(routine.writes, true);
  assert.equal(writesOf(f, routine.id), true);
  assert.equal(f.routines.writable(f.reminders.bindings.get(routine.id)), true);
  assert.deepEqual(writeAudits(f).at(-1).details, {
    kind: "routine-writes",
    routineId: routine.id,
    writes: true,
    actor: "assistant",
    channel: "tool",
  });
  // Without the parameter a routine stays read-only, as before.
  const quiet = await f.create();
  assert.equal(quiet.writes, false);
  assert.equal(writeAudits(f).length, 1);
  // An owner's Telegram turn is his direct request too.
  const channel = f.service.store.get(f.channel.id);
  const telegram = {
    kind: "telegram",
    channelId: channel.id,
    chatId: channel.chatId,
    userId: channel.userId,
  };
  assert.equal((await f.create({ writes: true }, telegram)).writes, true);
});

test("the agent switches May write on and off with an update", async (t) => {
  const f = setup(t);
  const routine = await f.create();
  const on = await f.call({
    action: "update",
    id: routine.id,
    writes: true,
    revision: routine.revision,
  });
  assert.equal(on.writes, true);
  assert.equal(on.revision, routine.revision + 1);
  assert.equal(writesOf(f, routine.id), true);
  const off = await f.call({
    action: "update",
    id: routine.id,
    writes: false,
    revision: on.revision,
  });
  assert.equal(off.writes, false);
  assert.equal(writesOf(f, routine.id), false);
  assert.equal(off.enabled, true, "the routine keeps running");
  assert.deepEqual(
    writeAudits(f).map((e) => [e.details.writes, e.details.actor]),
    [
      [true, "assistant"],
      [false, "assistant"],
    ],
  );
  await assert.rejects(
    f.call({ action: "update", id: routine.id, writes: "yes", revision: off.revision }),
    { status: 400 },
  );
  await assert.rejects(f.create({ writes: 1 }), { status: 400 });
});

test("scheduled, forwarded and member turns cannot switch May write", async (t) => {
  const f = setup(t);
  const routine = await f.create();
  for (const origin of [
    { kind: "routine" },
    { kind: "heartbeat" },
    { kind: "owner", forwarded: true },
    { kind: "team-member", teamId: "team-1", memberId: "m" },
    { kind: "lead-request", teamId: "team-1", memberId: "m" },
  ]) {
    await assert.rejects(f.create({ writes: true }, origin), { status: 403 });
    await assert.rejects(
      f.call(
        { action: "update", id: routine.id, writes: true, revision: routine.revision },
        origin,
      ),
      { status: 403 },
    );
  }
  assert.equal(writesOf(f, routine.id), false);
  assert.equal(f.reminders.bindings.list(f.id).length, 1);
  assert.equal(writeAudits(f).length, 0);
});

// The agent made a user's: Anna at `level`, her main chat open.
function forAnna(f, mode, level) {
  f.store.setUserAccess(
    f.id,
    { mode, members: [{ userId: "anna", level }] },
    f.store.getAssistant(f.id).revision,
  );
  const chat = f.store.saveConversation({
    assistantId: f.id,
    userId: "anna",
    runtimeSessionKey: "anna-session",
    main: true,
  });
  const anna = { kind: "user", userId: "anna" };
  const call = (input) => f.call(input, anna, chat.id);
  const create = (extra) =>
    call({
      action: "create",
      name: "Anna",
      prompt: "Plan.",
      trigger: schedule,
      ...extra,
    });
  return { chat, call, create };
}

test("a user's agent cannot switch May write: it is the owner's setting", async (t) => {
  for (const [mode, level] of [
    ["shared", "personalize"],
    ["shared", "extended"],
    ["own", "personalize"],
    ["own", "extended"],
  ]) {
    const f = setup(t);
    const anna = forAnna(f, mode, level);
    const error = await anna.create({ writes: true }).catch((e) => e);
    assert.equal(error.key, "routineWritesOwnerOnly", `${mode} ${level}`);
    assert.equal(error.status, 403);
    assert.equal(toolError(error).code, "ROUTINE_WRITES_OWNER_ONLY");
    assert.match(toolError(error).reason, /owner/);
    assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 0);
    const quiet = await anna.create();
    for (const writes of [true, false])
      await assert.rejects(
        anna.call({ action: "update", id: quiet.id, writes, revision: quiet.revision }),
        { key: "routineWritesOwnerOnly" },
      );
    assert.equal(writesOf(f, quiet.id), false);
    assert.equal(writeAudits(f).length, 0);
  }
});

test("a replayed create returns its routine without switching it again", async (t) => {
  const f = setup(t);
  const input = {
    action: "create",
    name: "Cleanup",
    prompt: f.input.prompt,
    trigger: schedule,
    writes: true,
  };
  const first = await f.call(input);
  const turn = f.last;
  // The owner switched it off in the settings before the call was retried.
  await f.routines.update(f.id, first.id, { writes: false, revision: first.revision });
  const again = await f.call(input, ownerTurn, f.channel.conversationId, turn);
  assert.equal(again.id, first.id);
  assert.equal(again.writes, false, "the owner's later choice stands");
  assert.equal(f.jobs.size, 1);
  assert.deepEqual(
    writeAudits(f).map((e) => e.details.actor),
    ["assistant", undefined],
  );
});

test("a retried create that finishes the routine logs May write once", async (t) => {
  const f = setup(t);
  const input = {
    action: "create",
    name: "Cleanup",
    prompt: f.input.prompt,
    trigger: schedule,
    writes: true,
  };
  // The first attempt stopped after reserving the record (still "prepared").
  const apply = f.assistants.config.apply;
  f.assistants.config.apply = async () => {
    throw new Error("down");
  };
  await assert.rejects(f.call(input));
  const turn = f.last;
  const [prepared] = f.reminders.bindings.list(f.id);
  assert.equal(prepared.state, "prepared");
  assert.equal(f.jobs.size, 0);
  f.assistants.config.apply = apply;
  const done = await f.call(input, ownerTurn, f.channel.conversationId, turn);
  assert.equal(done.id, prepared.id);
  assert.equal(done.writes, true);
  // A later replay of the now bound routine is not logged again.
  await f.call(input, ownerTurn, f.channel.conversationId, turn);
  assert.deepEqual(
    writeAudits(f).map((e) => [e.details.routineId, e.details.actor]),
    [[prepared.id, "assistant"]],
  );
});

test("a retried create that adopts the job of an unknown attempt logs May write", async (t) => {
  const f = setup(t);
  const input = {
    action: "create",
    name: "Cleanup",
    prompt: f.input.prompt,
    trigger: schedule,
    writes: true,
  };
  // The scheduler took the job but its answer was lost: the record is "unknown".
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, payload) => {
    const result = await call(method, payload);
    if (method === "cron.add") {
      f.assistants.runtime.client.call = call;
      throw new Error("lost");
    }
    return result;
  };
  await assert.rejects(f.call(input));
  const turn = f.last;
  const [unknown] = f.reminders.bindings.list(f.id);
  assert.equal(unknown.state, "unknown");
  const adopted = await f.call(input, ownerTurn, f.channel.conversationId, turn);
  assert.equal(adopted.id, unknown.id);
  assert.equal(adopted.writes, true);
  assert.equal(f.jobs.size, 1);
  assert.equal(writeAudits(f).length, 1);
});

test("the routine tool offers writes and explains May write; member routines do not", () => {
  const factories = [];
  plugin.register({
    pluginConfig: { url: "http://unused", token: "test" },
    registerTool: (f) => factories.push(f),
    on() {},
  });
  const tools = factories.map((f) => f.create({ agentId: "a", sessionKey: "s" }));
  const routine = tools.find((x) => x.name === "agentpier_routine");
  assert.deepEqual(routine.parameters.properties.writes, { type: "boolean" });
  assert.match(routine.description, /writes: true/);
  assert.match(routine.description, /ROUTINE_WRITES_OWNER_ONLY/);
  const member = tools.find((x) => x.name === "agentpier_team_member_routine");
  assert.equal(member.parameters.properties.writes, undefined);
  assert.match(member.description, /you cannot set that/);
});
