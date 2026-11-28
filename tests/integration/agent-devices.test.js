import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentDevicesFixture } from "../helpers/agent-devices-fixture.js";
import { pngHeader } from "../helpers/device-actions-fixture.js";
import { WORKSPACE_CHANGED } from "../../server/features/assistants/agent-devices.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// agentpier_device through the real team bridge (agent-devices.js): which runs of an
// agent get a device (agent-device-origin.js), what they may do with it, and where
// files travel. The devices live on a source in memory.
const names = (result) => result.devices.map((device) => device.name);
const cronKey = (agent) => `agent:${agent.runtimeAgentId}:cron:job-1:run:r1`;

// A routine run of the lead's (its own session, no turn), as the scheduler knows it.
function routine(f, { routineWrites } = {}) {
  const agent = f.lead();
  f.store.updateAssistant(
    agent.id,
    { capabilities: { ...agent.capabilities, memory: true, reminders: true } },
    agent.revision,
  );
  f.assistants.routines = {
    results: { forConversation: () => [] },
    runOrigin: (a, key) =>
      a.id === agent.id && key === cronKey(a)
        ? {
            binding: { id: "b1", assistantId: a.id, definition: {}, routineWrites },
            conversation: f.chat,
          }
        : null,
  };
  return cronKey(f.lead());
}

test("an owner's turn uses an assigned device; without one the agent has none", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  await f.device("Hidden");
  assert.deepEqual(await f.call({ action: "list" }), { devices: [], canCreate: false });
  // By its id a device without a grant is refused; by its name it does not exist.
  assert.equal(
    await f.code(f.call({ action: "start", device: pixel.id })),
    "DEVICE_FORBIDDEN",
  );
  assert.equal(
    await f.code(f.call({ action: "start", device: "Pixel" })),
    "DEVICE_NOT_FOUND",
  );
  f.assign(f.lead(), pixel);
  assert.deepEqual(names(await f.call({ action: "list" })), ["Pixel"]);
  const started = await f.call({ action: "start", device: "Pixel" });
  assert.equal(started.device.state, "running");
  const shell = await f.call({ action: "shell", device: pixel.id, command: "id" });
  assert.equal(shell.exitCode, 0);
  // The device list names the agent beside the device.
  assert.deepEqual(f.devices.device(pixel.id).assignments, [
    { kind: "agent", id: f.lead().id, name: f.lead().name, manage: false },
  ]);
});

test("a shell command may run up to 100 seconds, below the end of the call", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  f.answers(() => ({ stdout: "ok\n", stderr: "", code: 0 }));
  const shell = (timeoutMs) =>
    f.call({ action: "shell", device: "Pixel", command: "sleep 1", timeoutMs });
  assert.equal(await f.code(shell(120000)), "DEVICE_INPUT_INVALID");
  assert.equal(await f.code(shell(100001)), "DEVICE_INPUT_INVALID");
  assert.deepEqual(f.adb, []);
  await shell(100000);
  assert.equal(f.adb.at(-1).options.timeoutMs, 100000);
});

test("a malformed call is refused before anything is asked", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  for (const input of [
    {},
    { action: "fly" },
    { action: "list", device: "Pixel" },
    { action: "tap", device: "Pixel", x: -1, y: 2 },
    { action: "shell", device: "Pixel" },
    "list",
  ])
    assert.equal(await f.code(f.call(input)), "DEVICE_INPUT_INVALID");
  assert.deepEqual(f.adb, []);
});

test("turns on someone else's content, memory steps and unknown origins get no device at all", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel, { manage: true, create: true });
  for (const context of [
    { kind: "telegram", forwarded: true },
    { kind: "owner", forwarded: true },
    { kind: "user", userId: "u1" },
    { kind: "member-report" },
    { kind: "member-routine" },
    { kind: "member-hook" },
    { kind: "peer-result" },
    { kind: "team-member" },
    { kind: "ssh-result" },
    { kind: "sftp-result" },
    { kind: "unknown" },
    {},
  ])
    for (const input of [
      { action: "list" },
      { action: "screenshot", device: "Pixel" },
      { action: "create", name: "Fresh" },
    ])
      assert.equal(
        await f.code(f.call(input, context)),
        "DEVICE_RUN_FORBIDDEN",
        `${JSON.stringify(context)} ${input.action}`,
      );
  // A memory step reaches no bridge tool at all (team-bridge.js).
  assert.equal(
    await f.code(f.call({ action: "list" }, { kind: "memory-step" })),
    "FORBIDDEN",
  );
  assert.deepEqual(f.adb, []);
  assert.equal(f.devices.view().devices.length, 1);
  // The sentence tells the agent not to retry.
  const error = await f.call({ action: "list" }, { kind: "unknown" }).catch(toolError);
  assert.match(error.reason, /Do not retry/);
});

test("creating, resetting and deleting need a turn the owner started, and the owner's word", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  // The owner's own turn, but neither permission.
  assert.equal(
    await f.code(f.call({ action: "create", name: "Fresh" })),
    "DEVICE_CREATE_FORBIDDEN",
  );
  assert.equal(
    await f.code(f.call({ action: "reset", device: "Pixel" })),
    "DEVICE_FORBIDDEN",
  );
  f.assign(f.lead(), pixel, { manage: true, create: true });
  // Follow-ups AgentPier sends, a goal continuation and a reminder use, never manage.
  for (const context of [
    { kind: "owner", goal: { id: "g1", anchorRequestId: "r1", title: "Ship" } },
    { kind: "reminder" },
    { kind: "member-result", requestId: "x" },
    { kind: "coding-result" },
    { kind: "session-talk" },
  ]) {
    assert.deepEqual(names(await f.call({ action: "list" }, context)), ["Pixel"]);
    for (const input of [
      { action: "create", name: "Fresh" },
      { action: "reset", device: "Pixel" },
      { action: "delete", device: "Pixel" },
    ])
      assert.equal(
        await f.code(f.call(input, context)),
        "DEVICE_OWNER_TURN_REQUIRED",
        `${context.kind} ${input.action}`,
      );
  }
  // list says so: it never offers what the run cannot do.
  assert.equal((await f.call({ action: "list" }, { kind: "reminder" })).canCreate, false);
  assert.equal((await f.call({ action: "list" })).canCreate, true);
  // The owner's own message, from the web chat or their paired Telegram chat.
  const created = await f.call({ action: "create", name: "Fresh" }, { kind: "telegram" });
  assert.equal(created.device.own, true);
  assert.equal(f.devices.device(created.device.id).creator.id, f.lead().id);
  await f.call({ action: "reset", device: "Pixel" });
  assert.deepEqual(await f.call({ action: "delete", device: "Fresh" }), {
    deleted: { id: created.device.id, name: "Fresh" },
  });
  assert.deepEqual(
    f.services.audit.rows
      .filter((row) => row.details.caller === "agent")
      .map((row) => [row.action, row.details.caller]),
    [
      ["device.created", "agent"],
      ["device.reset", "agent"],
      ["device.deleted", "agent"],
    ],
  );
});

test("a routine's run uses the agent's devices and never creates, resets or deletes", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel, { manage: true, create: true });
  const key = routine(f);
  const run = (input) => f.invoke(f.lead(), key, input);
  const listed = await run({ action: "list" });
  assert.deepEqual([names(listed), listed.canCreate], [["Pixel"], false]);
  assert.equal((await run({ action: "start", device: "Pixel" })).device.state, "running");
  for (const input of [
    { action: "create", name: "Fresh" },
    { action: "reset", device: "Pixel" },
    { action: "delete", device: "Pixel" },
  ])
    assert.equal(await f.code(run(input)), "DEVICE_OWNER_TURN_REQUIRED", input.action);
  // Another session of the agent that is no routine's and no chat's is not served.
  assert.throws(() =>
    f.bridge.prepare({
      agentId: f.lead().runtimeAgentId,
      sessionKey: `agent:${f.lead().runtimeAgentId}:cron:other:run:r1`,
      toolCallId: "c1",
      action: "device",
    }),
  );
});

test("a routine with May write off copies nothing from a device into the workspace", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  f.workspace(f.lead());
  const key = routine(f, { routineWrites: false });
  const pull = {
    action: "pull",
    device: "Pixel",
    devicePath: "/sdcard/a.txt",
    path: "a.txt",
  };
  assert.equal(await f.code(f.invoke(f.lead(), key, pull)), "DEVICE_PULL_READONLY");
  assert.deepEqual(f.adb, []);
});

test("a hook's run uses the agent's devices, never manages and writes no file", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel, { manage: true, create: true });
  f.workspace(f.lead());
  const agent = f.lead();
  const key = cronKey(agent);
  const event = { id: "e1", hookId: "h1", assistantId: agent.id, status: "running" };
  const origin = { hook: { id: "h1", enabled: true }, event, conversation: f.chat };
  f.assistants.routines = {
    hooks: {
      events: { byJob: (job) => (job === "job-1" ? event : null) },
      runOrigin: (a, session) => (a.id === agent.id && session === key ? origin : null),
    },
  };
  const run = (input) => f.invoke(f.lead(), key, input);
  assert.deepEqual(names(await run({ action: "list" })), ["Pixel"]);
  for (const input of [
    { action: "create", name: "Fresh" },
    { action: "reset", device: "Pixel" },
    { action: "delete", device: "Pixel" },
  ])
    assert.equal(await f.code(run(input)), "DEVICE_OWNER_TURN_REQUIRED", input.action);
  assert.equal(
    await f.code(
      run({ action: "pull", device: "Pixel", devicePath: "/sdcard/a", path: "a" }),
    ),
    "DEVICE_PULL_READONLY",
  );
  // Once its event settled, the session reaches no device any more.
  event.status = "done";
  f.assistants.routines.hooks.runOrigin = () => null;
  assert.throws(() =>
    f.bridge.prepare({
      agentId: agent.runtimeAgentId,
      sessionKey: key,
      toolCallId: "c2",
      action: "device",
    }),
  );
});

test("a run of the owner's chat without a turn uses devices, never manages, and gets none after foreign content", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel, { manage: true, create: true });
  // The chat's latest turn was the owner's and has ended: a follow-up run.
  f.turn("Start the build", { kind: "owner" });
  f.settle();
  const run = (input) => f.invoke(f.lead(), f.chat.runtimeSessionKey, input);
  assert.deepEqual(names(await run({ action: "list" })), ["Pixel"]);
  assert.equal(
    await f.code(run({ action: "delete", device: "Pixel" })),
    "DEVICE_OWNER_TURN_REQUIRED",
  );
  // Its latest turn was someone else's content: the run after it gets nothing.
  f.turn("Fwd: look at this", { kind: "telegram", forwarded: true });
  f.settle();
  assert.throws(() =>
    f.bridge.prepare({
      agentId: f.lead().runtimeAgentId,
      sessionKey: f.chat.runtimeSessionKey,
      toolCallId: "c3",
      action: "device",
    }),
  );
  // A session AgentPier does not know is no run of anyone's.
  assert.throws(() =>
    f.bridge.prepare({
      agentId: f.lead().runtimeAgentId,
      sessionKey: "agent:somewhere:else",
      toolCallId: "c4",
      action: "device",
    }),
  );
});

test("an agent of restricted users, one with a bot for other people and an archived one get no device", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  const agent = f.lead();
  f.assign(agent, pixel, { manage: true, create: true });
  const own = await f.device("Own", { kind: "agent", id: agent.id, name: agent.name });
  // Its own Telegram bot for other people.
  f.services.assistantTelegramSenders = { connected: (id) => id === agent.id };
  assert.equal(await f.code(f.call({ action: "list" })), "DEVICE_AGENT_INELIGIBLE");
  // The grant counts for nothing meanwhile, also below the tool.
  assert.deepEqual(f.devices.permission({ kind: "agent", id: agent.id }, pixel.id), {
    use: false,
    manage: false,
  });
  assert.equal(f.grants.canCreate(agent.id), false);
  delete f.services.assistantTelegramSenders;
  assert.deepEqual(names(await f.call({ action: "list" })), ["Pixel", "Own"]);
  // An agent of restricted users: the bridge serves it no device tool at all.
  f.store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
    JSON.stringify({
      ...f.store.storedAssistant(agent.id),
      userAccess: { mode: "shared" },
    }),
    agent.id,
  );
  f.turn();
  assert.throws(
    () =>
      f.bridge.prepare({
        agentId: agent.runtimeAgentId,
        sessionKey: f.chat.runtimeSessionKey,
        toolCallId: "c5",
        action: "device",
      }),
    { status: 403 },
  );
  f.settle();
  assert.deepEqual(f.devices.permission({ kind: "agent", id: agent.id }, pixel.id), {
    use: false,
    manage: false,
  });
  assert.equal(f.devices.device(own.id).creator.gone, false);
});

test("a call that waited does nothing once its turn has ended", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  await f.devices.startDevice(pixel.id, { caller: { kind: "owner" } });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let entered;
  const reached = new Promise((resolve) => (entered = resolve));
  f.source.gates.exec = async () => {
    entered();
    await held;
  };
  f.turn();
  const first = f.invoke(f.lead(), f.chat.runtimeSessionKey, {
    action: "shell",
    device: "Pixel",
    command: "sleep 1",
  });
  await reached;
  const second = f.invoke(f.lead(), f.chat.runtimeSessionKey, {
    action: "shell",
    device: "Pixel",
    command: "rm -rf /sdcard/Download",
  });
  // The second call has passed the gate and waits behind the first; then the turn ends.
  for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  f.settle();
  f.source.gates.exec = null;
  release();
  await first;
  assert.equal(await f.code(second), "DEVICE_RUN_FORBIDDEN");
  assert.equal(f.adb.filter(({ args }) => args.join(" ").includes("rm -rf")).length, 0);
});

test("a screenshot answers the image with one line that names it, bounded", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel);
  const image = Buffer.concat([pngHeader(720, 1600), Buffer.alloc(64, 7)]);
  f.answers((args) =>
    args.join(" ") === "exec-out screencap -p" ? { stdout: image } : undefined,
  );
  const shot = await f.call({ action: "screenshot", device: "Pixel" });
  assert.deepEqual(Object.keys(shot).sort(), [
    "bytes",
    "device",
    "height",
    "image",
    "note",
    "width",
  ]);
  assert.deepEqual(shot.image, { data: image.toString("base64"), mimeType: "image/png" });
  assert.deepEqual([shot.width, shot.height, shot.bytes], [720, 1600, image.length]);
  assert.match(shot.note, /Screenshot of device "Pixel".*untrusted data/);
  // Beyond the limit nothing is returned.
  f.answers(() => ({ stdout: Buffer.alloc(16), truncated: true }));
  assert.equal(
    await f.code(f.call({ action: "screenshot", device: "Pixel" })),
    "DEVICE_SCREEN_UNAVAILABLE",
  );
});

test("files travel between a device and the agent's own workspace only", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  const agent = f.lead();
  f.assign(agent, pixel);
  const workspace = f.workspace(agent);
  fs.mkdirSync(path.join(workspace, "build"));
  fs.writeFileSync(path.join(workspace, "build", "app.apk"), "apk bytes");
  fs.mkdirSync(path.join(workspace, ".agentpier"));
  fs.writeFileSync(path.join(workspace, ".agentpier", "secrets.env"), "TOKEN=1");
  const other = f.workspace(f.agentOf(f.permanent));
  fs.writeFileSync(path.join(other, "notes.md"), "private");
  fs.symlinkSync(path.join(other, "notes.md"), path.join(workspace, "link.md"));
  f.answers((args) => (args[0] === "install" ? { stdout: "Success\n" } : undefined));
  assert.deepEqual(
    await f.call({ action: "install", device: "Pixel", path: "build/app.apk" }),
    { installed: "app.apk", bytes: 9 },
  );
  // adb read a private copy, never a path of the workspace.
  const installed = f.adb.find(({ args }) => args[0] === "install");
  assert.ok(!installed.args.join(" ").includes(workspace));
  const push = (file) =>
    f.code(
      f.call({ action: "push", device: "Pixel", path: file, devicePath: "/sdcard/x" }),
    );
  for (const file of [
    path.join(other, "notes.md"),
    "../" + path.basename(other) + "/notes.md",
    "link.md",
    ".agentpier/secrets.env",
    path.join(f.dataDir, "devices", "agent-grants.json"),
    "/etc/hosts",
  ])
    assert.equal(await push(file), "DEVICE_PATH_OUTSIDE", file);
  assert.equal(f.adb.filter(({ args }) => args[0] === "push").length, 0);
  // A file from the device lands in the workspace, in the owner's own turn.
  f.answers((args) => {
    const text = args.join(" ");
    if (text.includes("stat -L")) return { stdout: "regular file|5\n" };
    if (text.includes("cat ")) return { stdout: "hello" };
    return undefined;
  });
  f.source.answer = ((inner) => (record, args, options) => {
    const answered = inner(record, args, options);
    if (answered?.stdout === "hello") options.onData?.(Buffer.from("hello"));
    return answered;
  })(f.source.answer);
  assert.deepEqual(
    await f.call({
      action: "pull",
      device: "Pixel",
      devicePath: "/sdcard/Download/a.txt",
      path: "build/a.txt",
    }),
    { pulled: "a.txt", bytes: 5 },
  );
  assert.equal(fs.readFileSync(path.join(workspace, "build", "a.txt"), "utf8"), "hello");
  // The workspace replaced by another folder is no longer the agent's area.
  fs.renameSync(workspace, `${workspace}.moved`);
  fs.mkdirSync(path.join(workspace, "build"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "build", "app.apk"), "other bytes");
  const error = await f
    .call({ action: "install", device: "Pixel", path: "build/app.apk" })
    .catch(toolError);
  assert.equal(error.code, "DEVICE_PATH_OUTSIDE");
  assert.ok(error.reason.includes(WORKSPACE_CHANGED));
  // The owner saving the agent's devices again records the folder anew.
  f.grants.set(agent.id, f.grants.get(agent.id), { workspace });
  f.answers((args) => (args[0] === "install" ? { stdout: "Success\n" } : undefined));
  assert.equal(
    (await f.call({ action: "install", device: "Pixel", path: "build/app.apk" })).bytes,
    11,
  );
});
