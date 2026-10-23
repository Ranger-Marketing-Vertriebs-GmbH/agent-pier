import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";

// AGENTPIER-195: on the person's own direct request, in any of her chats, the agent
// switches a reminder's or routine's extra Telegram delivery with its own tools. The
// destination stays that person's paired chat; the agent never names a recipient.
const schedule = { kind: "cron", expr: "0 8 * * *", tz: "Europe/Berlin" };
const ownerTurn = { kind: "owner" };

function setup(t, options) {
  const f = routineFixture(t, options);
  let context = ownerTurn;
  f.assistants.teams = { store: { context: () => context } };
  let n = 0;
  // One tool call in a turn of the main chat (or `conversationId`) with `origin`.
  f.call = async (
    tool,
    input,
    origin = ownerTurn,
    conversationId = f.channel.conversationId,
  ) => {
    context = origin;
    const request = f.assistants.ledger.accept(conversationId, {
      clientRequestId: `turn-${++n}`,
      text: "gerne auch über Telegram",
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    return f[tool].invoke(
      { attemptId: attempt.id, toolCallId: `call-${n}`, assertCurrent() {} },
      input,
    );
  };
  f.createRoutine = (extra = {}, origin) =>
    f.call(
      "routines",
      {
        action: "create",
        name: "Meal plan",
        prompt: f.input.prompt,
        trigger: schedule,
        ...extra,
      },
      origin,
    );
  f.createReminder = (extra = {}, origin) =>
    f.call(
      "reminders",
      {
        action: "create",
        name: "Water",
        message: "Water the plants.",
        schedule,
        ...extra,
      },
      origin,
    );
  return f;
}

const telegramOf = (f, id) => f.reminders.bindings.get(id).telegram;

test("an owner's web-chat turn creates a routine and a reminder with Telegram on", async (t) => {
  const f = setup(t);
  const routine = await f.createRoutine({ telegram: true });
  const reminder = await f.createReminder({ telegram: true });
  for (const item of [routine, reminder]) {
    assert.equal(item.telegram, true);
    assert.equal(telegramOf(f, item.id).channelId, f.channel.id);
    assert.equal(telegramOf(f, item.id).chatId, f.channel.chatId);
  }
  // Without the parameter a web-chat turn stays without Telegram, as before.
  const quiet = await f.createRoutine();
  assert.equal(quiet.telegram, false);
});

test("the agent switches Telegram on and off with an update from the web chat", async (t) => {
  const f = setup(t);
  const routine = await f.createRoutine();
  const on = await f.call("routines", {
    action: "update",
    id: routine.id,
    telegram: true,
    revision: routine.revision,
  });
  assert.equal(on.telegram, true);
  assert.equal(telegramOf(f, routine.id).channelId, f.channel.id);
  const off = await f.call("routines", {
    action: "update",
    id: routine.id,
    telegram: false,
    revision: on.revision,
  });
  assert.equal(off.telegram, false);
  assert.equal(telegramOf(f, routine.id), null);
  assert.equal(off.enabled, true, "the routine keeps running");
  const reminder = await f.createReminder();
  const [listed] = (await f.call("reminders", { action: "list" })).reminders;
  const loud = await f.call("reminders", {
    action: "update",
    id: reminder.id,
    telegram: true,
    revision: listed.revision,
  });
  assert.equal(loud.telegram, true);
  const quiet = await f.call("reminders", {
    action: "update",
    id: reminder.id,
    telegram: false,
    revision: loud.revision,
  });
  assert.equal(quiet.telegram, false);
});

test("a Telegram turn may switch the extra delivery off when creating", async (t) => {
  const f = setup(t);
  const channel = f.service.store.get(f.channel.id);
  const telegram = {
    kind: "telegram",
    channelId: channel.id,
    chatId: channel.chatId,
    userId: channel.userId,
  };
  // Without the parameter a Telegram turn delivers there too, as before.
  assert.equal((await f.createRoutine({}, telegram)).telegram, true);
  assert.equal((await f.createRoutine({ telegram: false }, telegram)).telegram, false);
});

test("without a paired chat telegram: true is refused with a code to relay", async (t) => {
  const f = setup(t, { paired: false });
  const error = await f.createRoutine({ telegram: true }).catch((e) => e);
  assert.equal(error.key, "reminderChannelRequired");
  assert.equal(toolError(error).code, "TELEGRAM_NOT_CONNECTED");
  assert.match(toolError(error).reason, /pair/i);
  await assert.rejects(f.createReminder({ telegram: true }), {
    key: "reminderChannelRequired",
  });
  assert.equal(f.reminders.bindings.list(f.id).filter((b) => b.nativeId).length, 0);
  const routine = await f.createRoutine();
  await assert.rejects(
    f.call("routines", {
      action: "update",
      id: routine.id,
      telegram: true,
      revision: routine.revision,
    }),
    { key: "reminderChannelRequired" },
  );
  assert.equal(telegramOf(f, routine.id), null);
});

test("scheduled, forwarded and member turns cannot switch Telegram", async (t) => {
  const f = setup(t);
  const routine = await f.createRoutine();
  for (const origin of [
    { kind: "routine" },
    { kind: "heartbeat" },
    { kind: "owner", forwarded: true },
    { kind: "team-member", teamId: "team-1", memberId: "m" },
  ]) {
    await assert.rejects(f.createRoutine({ telegram: true }, origin), { status: 403 });
    await assert.rejects(f.createReminder({ telegram: true }, origin), { status: 403 });
    await assert.rejects(
      f.call(
        "routines",
        { action: "update", id: routine.id, telegram: true, revision: routine.revision },
        origin,
      ),
      { status: 403 },
    );
  }
  assert.equal(telegramOf(f, routine.id), null);
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
  const call = (input) => f.call("routines", input, anna, chat.id);
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

test("a user who cannot pair Telegram is told it is unavailable, not to pair", async (t) => {
  for (const [mode, level] of [
    ["shared", "personalize"],
    ["shared", "extended"],
    ["own", "personalize"],
  ]) {
    const f = setup(t);
    const anna = forAnna(f, mode, level);
    // The agent's only Telegram chat is the owner's: never Anna's destination.
    const error = await anna.create({ telegram: true }).catch((e) => e);
    assert.equal(error.key, "reminderTelegramUnavailable", `${mode} ${level}`);
    assert.equal(toolError(error).code, "TELEGRAM_UNAVAILABLE");
    assert.doesNotMatch(toolError(error).reason, /pair Telegram in/);
    const quiet = await anna.create();
    await assert.rejects(
      anna.call({
        action: "update",
        id: quiet.id,
        telegram: true,
        revision: quiet.revision,
      }),
      { key: "reminderTelegramUnavailable" },
    );
    assert.equal(telegramOf(f, quiet.id), null);
  }
});

test("an Extended user on her own agent is told to pair, then uses her chat", async (t) => {
  const f = setup(t);
  const anna = forAnna(f, "own", "extended");
  const error = await anna.create({ telegram: true }).catch((e) => e);
  assert.equal(error.key, "reminderChannelRequired");
  assert.equal(toolError(error).code, "TELEGRAM_NOT_CONNECTED");
  // Once she paired the agent's bot with her own chat, her request delivers there.
  const channel = f.service.store.get(f.channel.id);
  f.service.store.write({ ...channel, conversationId: anna.chat.id }, channel.revision);
  const loud = await anna.create({ telegram: true });
  assert.equal(f.reminders.bindings.get(loud.id).userId, "anna");
  assert.equal(telegramOf(f, loud.id).channelId, f.channel.id);
});

test("a retried create returns its routine even after Telegram was unpaired", async (t) => {
  const f = setup(t);
  const input = { ...f.input, telegram: true };
  const first = await f.routines.create(f.id, input);
  f.service.store.disconnect(f.channel.id, f.service.store.get(f.channel.id).revision);
  const again = await f.routines.create(f.id, input);
  assert.equal(again.id, first.id);
  assert.equal(f.jobs.size, 1);
});

test("the tool schemas offer telegram and tell the agent it may switch it", () => {
  const factories = [];
  plugin.register({
    pluginConfig: { url: "http://unused", token: "test" },
    registerTool: (f) => factories.push(f),
    on() {},
  });
  const tools = factories.map((f) => f.create({ agentId: "a", sessionKey: "s" }));
  for (const name of ["agentpier_routine", "agentpier_reminder"]) {
    const tool = tools.find((x) => x.name === name);
    assert.deepEqual(tool.parameters.properties.telegram, { type: "boolean" }, name);
    assert.match(tool.description, /telegram: true/, name);
  }
});
