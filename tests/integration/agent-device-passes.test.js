import test from "node:test";
import assert from "node:assert/strict";
import { agentDevicesFixture } from "../helpers/agent-devices-fixture.js";
import { taskOrigin } from "../../server/features/assistants/agent-device-origin.js";
import { taskDevices } from "../../server/features/assistants/member-device-passes.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { agentDevicesTopic } from "../../server/features/devices/agent-device-access.js";
import { devicesTopic } from "../../server/features/devices/live-topics.js";

// A lead passes Android devices on to a member with one task
// (member-device-passes.js, agentpier_team_delegate `access.devices`), through the
// real team service and bridge.
const names = (result) => result.devices.map((device) => device.name);

// One task of the lead's for `member` from a turn AgentPier recorded with `context`;
// the member's turn on it has started when this returns.
async function delegate(f, member, access, context = { kind: "owner" }) {
  f.settle();
  const inv = f.turn("Please have the app checked on the phone", context);
  const result = await f.service.delegate(inv, {
    memberId: member.id,
    task: "Check the app on the phone",
    ...(access && { access }),
  });
  return f.service.requests.store.get(result.requestId);
}
// One call of the member in the turn it is working on.
const inTask = (f, member, input) =>
  f.invoke(f.agentOf(member), f.chatOf(member).runtimeSessionKey, input);

test("a member uses a passed device in that task only, and never resets, deletes or creates", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  const tablet = await f.device("Tablet");
  f.assign(f.lead(), pixel, { manage: true, create: true });
  f.assign(f.lead(), tablet);
  const member = f.agentOf(f.permanent);
  const task = await delegate(f, f.permanent, { devices: ["Pixel"] });
  assert.deepEqual(task.devices, [pixel.id]);
  const listed = await inTask(f, f.permanent, { action: "list" });
  assert.deepEqual(listed, {
    devices: [
      {
        id: pixel.id,
        name: "Pixel",
        state: "stopped",
        own: false,
        manage: false,
        held: false,
      },
    ],
    canCreate: false,
  });
  assert.equal(
    (await inTask(f, f.permanent, { action: "start", device: "Pixel" })).device.state,
    "running",
  );
  for (const input of [
    { action: "reset", device: "Pixel" },
    { action: "delete", device: "Pixel" },
    { action: "create", name: "Fresh" },
  ])
    assert.equal(
      await f.code(inTask(f, f.permanent, input)),
      "DEVICE_OWNER_TURN_REQUIRED",
      input.action,
    );
  // Below the tool the pass never carries the right to reset or delete either.
  assert.deepEqual(f.devices.permission({ kind: "agent", id: member.id }, pixel.id), {
    use: true,
    manage: false,
  });
  // What the lead did not pass on stays the lead's.
  assert.equal(
    await f.code(inTask(f, f.permanent, { action: "start", device: tablet.id })),
    "DEVICE_FORBIDDEN",
  );
  // The device list names the member beside the device, and the pass is audited.
  assert.deepEqual(
    f.devices.device(pixel.id).assignments.find((entry) => entry.id === member.id),
    {
      kind: "agent",
      id: member.id,
      name: member.name,
      manage: false,
      passedBy: { id: f.lead().id, name: f.lead().name },
    },
  );
  const audited = f.services.audit.rows.find((row) => row.details.kind === "lead-share");
  assert.deepEqual(
    [audited.resourceId, audited.details.devices, audited.details.requestId],
    [member.id, 1, task.id],
  );
  // A member the lead passed nothing on to has nothing.
  assert.deepEqual(names(await f.memberCall(f.second, { action: "list" })), []);
  // In the member's own chat with the owner the pass does not count, while its
  // task is still open and the device service still knows the pass.
  assert.deepEqual(names(await f.memberCall(f.permanent, { action: "list" })), []);
  assert.equal(
    await f.code(f.memberCall(f.permanent, { action: "start", device: pixel.id })),
    "DEVICE_FORBIDDEN",
  );
  assert.equal(f.service.requests.store.get(task.id).phase, "running");
  assert.equal(
    f.devices.permission({ kind: "agent", id: member.id }, pixel.id).use,
    true,
  );
  // The task ends, and the pass with it.
  f.finish(task);
  f.settle();
  assert.deepEqual(names(await f.memberCall(f.permanent, { action: "list" })), []);
  assert.deepEqual(f.devices.permission({ kind: "agent", id: member.id }, pixel.id), {
    use: false,
    manage: false,
  });
  assert.equal(
    f.devices.device(pixel.id).assignments.some((entry) => entry.id === member.id),
    false,
  );
});

test("a pass counts only while the lead still has the device", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  await delegate(f, f.permanent, { devices: [pixel.id] });
  assert.deepEqual(names(await inTask(f, f.permanent, { action: "list" })), ["Pixel"]);
  // The owner takes the device away from the lead.
  f.grants.set(f.lead().id, { devices: [], create: false });
  assert.deepEqual(names(await inTask(f, f.permanent, { action: "list" })), []);
  assert.equal(
    await f.code(inTask(f, f.permanent, { action: "start", device: pixel.id })),
    "DEVICE_FORBIDDEN",
  );
  // And gives it back: the open task's pass counts again.
  f.assign(f.lead(), pixel);
  assert.deepEqual(names(await inTask(f, f.permanent, { action: "list" })), ["Pixel"]);
  // A lead with its own bot for other people hands nothing on.
  f.services.assistantTelegramSenders = { connected: (id) => id === f.lead().id };
  assert.equal(
    await f.code(inTask(f, f.permanent, { action: "list" })),
    "DEVICE_RUN_FORBIDDEN",
  );
});

test("a lead passes on only what it has itself, and nothing from a run that gets no device", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  await f.device("Hidden");
  f.assign(f.lead(), pixel);
  const refused = async (access, context) => {
    const open = f.service.requests.store.list().length;
    const error = await delegate(f, f.permanent, access, context).then(
      () => null,
      (e) => toolError(e).code,
    );
    // No task was started.
    assert.equal(f.service.requests.store.list().length, open);
    return error;
  };
  for (const devices of [
    ["Hidden"],
    ["Pixel", "Hidden"],
    [],
    "Pixel",
    [7],
    ["d-000000000000"],
  ])
    assert.equal(
      await refused({ devices }),
      "DEVICE_PASS_INVALID",
      JSON.stringify(devices),
    );
  for (const context of [
    { kind: "telegram", forwarded: true },
    { kind: "member-report" },
    { kind: "unknown" },
  ])
    assert.equal(
      await refused({ devices: ["Pixel"] }, context),
      "DEVICE_RUN_FORBIDDEN",
      context.kind,
    );
  // A device the lead created itself is its own to pass on.
  const own = await f.device("Own", { kind: "agent", id: f.lead().id, name: "Lead" });
  const task = await delegate(f, f.permanent, { devices: ["Own", pixel.id, "Own"] });
  assert.deepEqual(task.devices, [own.id, pixel.id]);
});

test("a temporary member takes a pass with a task too", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  await delegate(f, f.temporary, { devices: ["Pixel"] });
  assert.deepEqual(names(await inTask(f, f.temporary, { action: "list" })), ["Pixel"]);
  assert.equal(
    await f.code(inTask(f, f.temporary, { action: "reset", device: "Pixel" })),
    "DEVICE_OWNER_TURN_REQUIRED",
  );
});

test("a member's own device works in its own runs, and in a task only when the task's origin allows devices", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  const phone = await f.device("Phone");
  const member = f.agentOf(f.permanent);
  f.assign(f.lead(), pixel);
  f.assign(member, phone, { manage: true });
  // Its own chat with the owner: like any agent, with what the owner allowed.
  assert.deepEqual(names(await f.memberCall(f.permanent, { action: "list" })), ["Phone"]);
  await f.memberCall(f.permanent, { action: "reset", device: "Phone" });
  // A task with a pass: both, and still no reset in a task.
  const task = await delegate(f, f.permanent, { devices: ["Pixel"] });
  assert.deepEqual(names(await inTask(f, f.permanent, { action: "list" })), [
    "Pixel",
    "Phone",
  ]);
  assert.equal(
    await f.code(inTask(f, f.permanent, { action: "reset", device: "Phone" })),
    "DEVICE_OWNER_TURN_REQUIRED",
  );
  f.finish(task);
  f.settle();
  // A task the lead started while it worked on someone else's content: no device at
  // all, not even the member's own.
  const foreign = await delegate(f, f.permanent, null, {
    kind: "telegram",
    forwarded: true,
  });
  assert.equal(foreign.devices, undefined);
  for (const input of [{ action: "list" }, { action: "start", device: "Phone" }])
    assert.equal(
      await f.code(inTask(f, f.permanent, input)),
      "DEVICE_RUN_FORBIDDEN",
      input.action,
    );
  f.finish(foreign);
  f.settle();
  // A colleague's answer is the colleague's content.
  f.memberTurn(f.second);
  assert.equal(
    await f.code(f.memberCall(f.permanent, { action: "list" }, { kind: "peer-result" })),
    "DEVICE_RUN_FORBIDDEN",
  );
});

test("a colleague's request is the colleague's content: the member working on it gets no device", async (t) => {
  const f = await agentDevicesFixture(t);
  const phone = await f.device("Phone");
  f.assign(f.agentOf(f.second), phone);
  f.settle();
  // A permanent member hands a task to its colleague (agentpier_team_peer_delegate).
  const peer = await f.peerDelegate(f.memberTurn(f.permanent), f.second);
  assert.equal(peer.fromMemberId, f.permanent.id);
  assert.equal(peer.memberAssistantId, f.agentOf(f.second).id);
  const working = (request) =>
    f.code(
      f.memberCall(
        f.second,
        { action: "shell", device: "Phone", command: "id" },
        { kind: "lead-request", requestId: request.id },
      ),
    );
  assert.equal(await working(peer), "DEVICE_RUN_FORBIDDEN");
  // Whatever origin the request records: it stays a colleague's while it names one.
  const doctored = f.service.store.write(f.service.requests.store.get(peer.id), {
    origin: { kind: "owner" },
  });
  assert.equal(taskOrigin(doctored.origin), true);
  assert.equal(await working(doctored), "DEVICE_RUN_FORBIDDEN");
  assert.deepEqual(taskDevices(f.services, { ...doctored, devices: [phone.id] }), []);
  assert.deepEqual(f.adb, []);
  // The same member's own turn with the owner uses its device.
  assert.equal(
    await f.code(
      f.memberCall(f.second, { action: "shell", device: "Phone", command: "id" }),
    ),
    null,
  );
});

test("a task that was asked to stop passes nothing on, before its member's turn has ended", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  const phone = await f.device("Phone");
  const member = f.agentOf(f.permanent);
  f.assign(f.lead(), pixel);
  f.assign(member, phone);
  const task = await delegate(f, f.permanent, { devices: ["Pixel"] });
  assert.deepEqual(names(await inTask(f, f.permanent, { action: "list" })), [
    "Pixel",
    "Phone",
  ]);
  // The lead, the owner or the deadline asks to stop: the member's turn still runs
  // and the task is not in a final phase yet.
  f.service.store.write(f.service.requests.store.get(task.id), {
    cancelRequested: true,
    cancelledBy: "lead",
  });
  assert.equal(f.service.requests.store.get(task.id).phase, "running");
  for (const input of [
    { action: "list" },
    { action: "shell", device: "Pixel", command: "id" },
    { action: "shell", device: "Phone", command: "id" },
  ])
    assert.equal(
      await f.code(inTask(f, f.permanent, input)),
      "DEVICE_RUN_FORBIDDEN",
      JSON.stringify(input),
    );
  assert.deepEqual(f.adb, []);
  assert.deepEqual(f.devices.permission({ kind: "agent", id: member.id }, pixel.id), {
    use: false,
    manage: false,
  });
  assert.equal(
    f.devices.device(pixel.id).assignments.some((entry) => entry.id === member.id),
    false,
  );
});

test("the device list and a member's devices are pushed when a pass ends", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  const member = f.agentOf(f.permanent);
  // The two topics as the live hub follows them while a tab watches.
  const signals = { devices: 0, agent: 0 };
  const stops = [
    devicesTopic(f.services).watch({ invalidate: () => signals.devices++ }),
    agentDevicesTopic(f.services).watch({
      param: member.id,
      invalidate: () => signals.agent++,
    }),
  ];
  t.after(() => stops.forEach((stop) => stop()));
  const since = () => {
    const seen = { ...signals };
    signals.devices = signals.agent = 0;
    return seen;
  };
  const passedTo = () =>
    f.devices.device(pixel.id).assignments.some((entry) => entry.id === member.id);
  const passed = () =>
    agentDevicesTopic(f.services)
      .read(null, member.id)
      .devices.find((device) => device.id === pixel.id).passed;
  // The lead asks to stop the task.
  let task = await delegate(f, f.permanent, { devices: ["Pixel"] });
  assert.deepEqual([passedTo(), passed()], [true, true]);
  since();
  await f.service.requests.stop(task.id, "lead");
  let seen = since();
  assert.ok(seen.devices > 0 && seen.agent > 0, JSON.stringify(seen));
  assert.deepEqual([passedTo(), passed()], [false, false]);
  // The member's turn ends, and the task reaches its final phase.
  const { attemptId } = f.service.requests.store.get(task.id);
  if (f.assistants.ledger.getAttempt(attemptId).state !== "cancelled")
    f.assistants.ledger.transition(attemptId, "cancelled");
  since();
  await f.service.requests.pass();
  assert.equal(f.service.requests.store.get(task.id).phase, "cancelled");
  seen = since();
  assert.ok(seen.devices > 0 && seen.agent > 0, JSON.stringify(seen));
  // A change of one chat only (a message, a streamed token) signals neither.
  f.assistants.changed({ conversationId: f.chat.id });
  assert.deepEqual(since(), { devices: 0, agent: 0 });
});
