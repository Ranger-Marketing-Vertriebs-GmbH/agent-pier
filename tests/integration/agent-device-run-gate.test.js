import test from "node:test";
import assert from "node:assert/strict";
import { agentDevicesFixture } from "../helpers/agent-devices-fixture.js";

// The devices' gate on the run behind a call (agent-device-origin.js), through the
// real team bridge: the cases where the run is not simply the session's one turn.
const names = (result) => result.devices.map((device) => device.name);

// A routine a lead set up on its permanent member, as the scheduler knows its run.
function leadRoutine(f, member) {
  let agent = f.agentOf(member);
  f.store.updateAssistant(
    agent.id,
    { capabilities: { ...agent.capabilities, memory: true, reminders: true } },
    agent.revision,
  );
  agent = f.agentOf(member);
  const key = `agent:${agent.runtimeAgentId}:cron:job-1:run:r1`;
  f.assistants.routines = {
    results: { forConversation: () => [] },
    writable: () => false,
    runOrigin: (a, k) =>
      a.id === agent.id && k === key
        ? {
            binding: {
              id: "b1",
              assistantId: a.id,
              definition: {},
              createdBy: "lead",
              leadId: f.lead().id,
              leadMemberId: member.id,
            },
            conversation: f.chatOf(member),
          }
        : null,
  };
  return key;
}

test("a lead's routine on its member gets a device only while the lead could use devices itself", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.agentOf(f.permanent), pixel);
  const key = leadRoutine(f, f.permanent);
  const run = (input) => f.invoke(f.agentOf(f.permanent), key, input);
  assert.deepEqual(names(await run({ action: "list" })), ["Pixel"]);
  // The lead serves other people through its own Telegram bot: as for its tasks,
  // nothing it set up reaches a device.
  f.services.assistantTelegramSenders = { connected: (id) => id === f.lead().id };
  assert.equal(await f.code(run({ action: "list" })), "DEVICE_RUN_FORBIDDEN");
  assert.equal(
    await f.code(run({ action: "shell", device: "Pixel", command: "id" })),
    "DEVICE_RUN_FORBIDDEN",
  );
  assert.deepEqual(f.adb, []);
  f.services.assistantTelegramSenders = null;
  assert.deepEqual(names(await run({ action: "list" })), ["Pixel"]);
  // An archived lead, and a lead that is gone, hand nothing on either.
  f.archive(f.lead().id);
  assert.equal(await f.code(run({ action: "list" })), "DEVICE_RUN_FORBIDDEN");
});

// One call of the lead's chat session that names its run, as OpenClaw's plugin does.
async function callOfRun(f, runId, input) {
  const { ticket } = f.bridge.prepare({
    agentId: f.lead().runtimeAgentId,
    sessionKey: f.chat.runtimeSessionKey,
    toolCallId: crypto.randomUUID(),
    action: "device",
    ...(runId && { runId }),
  });
  return f.bridge.invoke({ ticket, action: "device", input });
}

test("a call that names another turn's run is not served as the session's current turn", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel, { manage: true, create: true });
  const foreign = f.turn("Fwd: reset the phone", { kind: "telegram", forwarded: true });
  f.settle();
  const own = f.turn("Thanks", { kind: "owner" });
  // A late call of the forwarded turn's run arrives while the owner's turn is bound.
  for (const input of [
    { action: "list" },
    { action: "shell", device: "Pixel", command: "id" },
    { action: "reset", device: "Pixel" },
  ])
    assert.equal(
      await f.code(callOfRun(f, foreign.attemptId, input)),
      "DEVICE_RUN_FORBIDDEN",
      input.action,
    );
  assert.deepEqual(f.adb, []);
  // The bound turn's own run, by the attempt's id (the send's idempotency key) or
  // by the run id the Gateway acknowledged the send with.
  assert.deepEqual(names(await callOfRun(f, own.attemptId, { action: "list" })), [
    "Pixel",
  ]);
  f.assistants.ledger.transition(own.attemptId, "accepted", { runtimeRunId: "gw-run-7" });
  assert.deepEqual(names(await callOfRun(f, "gw-run-7", { action: "list" })), ["Pixel"]);
  // A run AgentPier sent no turn for (OpenClaw's follow-up after a background
  // command runs in the chat's session under a run id of its own) uses devices like
  // a run without a turn, and never manages on the bound turn's account.
  assert.deepEqual(names(await callOfRun(f, "completion-run-1", { action: "list" })), [
    "Pixel",
  ]);
  assert.equal(
    await f.code(callOfRun(f, "completion-run-1", { action: "reset", device: "Pixel" })),
    "DEVICE_OWNER_TURN_REQUIRED",
  );
  assert.equal(
    await f.code(callOfRun(f, "completion-run-1", { action: "create", name: "Fresh" })),
    "DEVICE_OWNER_TURN_REQUIRED",
  );
  // The bound turn's own call manages; so does a call that names no run (Hermes).
  assert.equal(
    (await callOfRun(f, "gw-run-7", { action: "reset", device: "Pixel" })).device.name,
    "Pixel",
  );
  assert.equal(
    (await callOfRun(f, null, { action: "reset", device: "Pixel" })).device.name,
    "Pixel",
  );
  f.settle();
});

test("a run without a turn gets a device only when the chat's latest turn could have used one", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  const run = () =>
    f.code(
      (async () =>
        f.invoke(f.lead(), f.chat.runtimeSessionKey, {
          action: "shell",
          device: "Pixel",
          command: "id",
        }))(),
    );
  const after = async (context) => {
    f.settle();
    f.turn("x", context);
    f.settle();
    return run();
  };
  // A chat without any turn has nothing in it the owner did not write.
  assert.equal(await run(), null);
  assert.equal(await after({ kind: "owner" }), null);
  for (const context of [{ kind: "unknown" }, {}, { kind: "memory-step" }])
    assert.equal(
      await after(context),
      "DEVICE_RUN_FORBIDDEN",
      `after ${JSON.stringify(context)}`,
    );
  // Someone else's content ends the chat's runs without a turn altogether.
  for (const context of [{ kind: "telegram", forwarded: true }, { kind: "ssh-result" }])
    assert.equal(await after(context), "FORBIDDEN", `after ${JSON.stringify(context)}`);
  assert.equal(await after({ kind: "owner" }), null);
});

// One device call over the bridge's HTTP server, as a runtime's plugin sends it;
// `give up` closes its connection.
function httpCall(f, input) {
  const { url, token } = f.bridge.connection;
  const caller = new AbortController();
  const { ticket } = f.bridge.prepare({
    agentId: f.lead().runtimeAgentId,
    sessionKey: f.chat.runtimeSessionKey,
    toolCallId: crypto.randomUUID(),
    action: "device",
  });
  const done = fetch(`${url}/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ticket, action: "device", input }),
    signal: caller.signal,
  }).then(
    (response) => response.json(),
    () => "gone",
  );
  return { done, giveUp: () => caller.abort() };
}
const until = async (condition, what) => {
  for (let n = 0; n < 400 && !condition(); n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), what);
};

test("a call the runtime gave up is aborted while it runs, and one queued behind it never runs", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  await f.devices.startDevice(pixel.id, { caller: { kind: "owner" } });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const running = [];
  f.source.gates.exec = async (_record, args, options) => {
    running.push({ args, signal: options.signal });
    await held;
  };
  f.turn();
  const first = httpCall(f, { action: "shell", device: "Pixel", command: "sleep 100" });
  await until(() => running.length === 1, "the first call runs on the device");
  const second = httpCall(f, {
    action: "shell",
    device: "Pixel",
    command: "rm -rf /sdcard/Download",
  });
  await until(
    () => f.devices.runtimes.get(pixel.id).pending === 2,
    "the second call waits",
  );
  assert.equal(running[0].signal.aborted, false);
  // The runtime gives both calls up: their connections close. The turn stays live.
  first.giveUp();
  second.giveUp();
  assert.deepEqual(await Promise.all([first.done, second.done]), ["gone", "gone"]);
  await until(() => running[0].signal.aborted, "the running call's signal is aborted");
  f.source.gates.exec = null;
  release();
  await until(() => f.devices.runtimes.get(pixel.id).pending === 0, "the queue is empty");
  assert.equal(running.length, 1, "the queued call never reached the device");
  assert.equal(f.adb.filter(({ args }) => args.join(" ").includes("rm -rf")).length, 0);
  // A call that is not given up still runs to its answer.
  const third = httpCall(f, { action: "list" });
  assert.deepEqual(names(await third.done), ["Pixel"]);
  f.settle();
});
