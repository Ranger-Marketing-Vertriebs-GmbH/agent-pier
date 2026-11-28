import test from "node:test";
import assert from "node:assert/strict";
import { openLive } from "../helpers/live-socket.js";
import { sessionDevicesApp } from "../helpers/session-devices-fixture.js";
import { signedInUser } from "../helpers/users.js";
import { liveGate } from "../../server/application/live-wiring.js";
import { sessionDevicesTopic } from "../../server/features/devices/session-device-access.js";
import { userMayWatch } from "../../server/http/route-access.js";

// The owner assigns Android devices to a coding session, at its launch and later
// (routes/session-devices.js), on an application whose devices run on the fake SDK.
const timeout = 60000;
const json = async (response) => ({
  status: response.status,
  body: await response.json(),
});
const refused = (code, status) => ({ status, body: { code, error: code } });
const none = { devices: [], create: false };

test("GET and PUT answer a session's device access", { timeout }, async (t) => {
  const a = await sessionDevicesApp(t);
  const pixel = await a.device("Pixel");
  const tablet = await a.device("Tablet");
  const session = await a.launch();
  const first = await a.f.request(a.route(session));
  assert.equal(first.headers.get("cache-control"), "no-store");
  const creator = { kind: "owner", id: "owner", name: "", gone: false };
  const row = (device, extra = {}) => ({
    id: device.id,
    name: device.name,
    state: "stopped",
    creator,
    assigned: false,
    manage: false,
    own: false,
    ...extra,
  });
  assert.deepEqual(await first.json(), {
    availability: { available: true, reason: null },
    eligible: true,
    // The fixture launches without AgentPier tools.
    tools: "missing",
    create: false,
    devices: [row(pixel), row(tablet)],
  });
  const saved = await a.assign(session, {
    devices: [{ deviceId: pixel.id, manage: true }],
    create: true,
  });
  assert.deepEqual(await json(saved), {
    status: 200,
    body: {
      availability: { available: true, reason: null },
      eligible: true,
      tools: "missing",
      create: true,
      devices: [row(pixel, { assigned: true, manage: true }), row(tablet)],
    },
  });
  assert.deepEqual(
    (await a.access(session)).devices.map((device) => device.assigned),
    [true, false],
  );
  // The device list names the session, and the device service lets it in.
  const view = await (await a.f.request("/api/devices")).json();
  assert.deepEqual(view.devices[0].assignments, [
    { kind: "session", id: session.id, name: session.name, manage: true },
  ]);
  assert.deepEqual(view.devices[1].assignments, []);
  const caller = { kind: "session", id: session.id };
  assert.deepEqual(a.devices.permission(caller, pixel.id), { use: true, manage: true });
  assert.deepEqual(a.devices.permission(caller, tablet.id), {
    use: false,
    manage: false,
  });
  assert.equal(a.f.application.sessionDeviceGrants.canCreate(session.id), true);
  // Without `manage` the session uses the device and may not reset it.
  await a.assign(session, {
    devices: [{ deviceId: pixel.id, manage: false }],
    create: false,
  });
  assert.deepEqual(a.devices.permission(caller, pixel.id), { use: true, manage: false });
  // Everything taken away again.
  assert.equal((await a.assign(session, none)).status, 200);
  assert.deepEqual(a.devices.permission(caller, pixel.id), { use: false, manage: false });
  assert.deepEqual(
    (await (await a.f.request("/api/devices")).json()).devices[0].assignments,
    [],
  );
});

test(
  "a malformed access, an unknown device and an unknown session",
  { timeout },
  async (t) => {
    const a = await sessionDevicesApp(t);
    const pixel = await a.device("Pixel");
    const session = await a.launch();
    for (const body of [
      undefined,
      {},
      { devices: [] },
      { create: true },
      { devices: [{ deviceId: pixel.id }], create: false },
      { devices: [{ deviceId: pixel.id, manage: true }], create: false, extra: 1 },
      { devices: [pixel.id], create: false },
      // A device that does not exist.
      { devices: [{ deviceId: "d-00000000ffff", manage: false }], create: false },
      {
        devices: [
          { deviceId: pixel.id, manage: true },
          { deviceId: pixel.id, manage: true },
        ],
        create: false,
      },
    ])
      assert.deepEqual(
        await json(await a.assign(session, body)),
        refused("DEVICE_ASSIGNMENT_INVALID", 400),
        JSON.stringify(body),
      );
    assert.deepEqual(a.f.application.sessionDeviceGrants.get(session), none);
    assert.equal((await a.f.request("/api/sessions/gone/devices")).status, 404);
    assert.equal((await a.assign({ id: "gone" }, none)).status, 404);
  },
);

test(
  "a launch takes the access; a session that cannot have devices is refused",
  { timeout },
  async (t) => {
    const a = await sessionDevicesApp(t);
    const pixel = await a.device("Pixel");
    const access = { devices: [{ deviceId: pixel.id, manage: true }], create: true };
    const launched = await a.launch({ deviceAccess: access });
    assert.deepEqual(a.f.application.sessionDeviceGrants.get(launched), access);
    assert.equal((await a.access(launched)).create, true);
    const start = (body) =>
      a.f.request("/api/sessions", {
        method: "POST",
        body: { cwd: a.f.project, agentbus: false, ...body },
      });
    // A shell is no coding session; refused before a session exists.
    const before = (await a.f.application.sessions.list()).length;
    assert.deepEqual(
      await json(await start({ accountId: "local-shell", deviceAccess: access })),
      {
        status: 409,
        body: { code: "DEVICE_SESSION_INELIGIBLE", error: "DEVICE_SESSION_INELIGIBLE" },
      },
    );
    for (const deviceAccess of [
      { devices: [{ deviceId: "d-00000000ffff", manage: false }], create: false },
      { devices: "all", create: true },
      null,
    ]) {
      const response = await start({ accountId: "local-codex", deviceAccess });
      assert.equal(response.status, 400, JSON.stringify(deviceAccess));
      assert.equal((await response.json()).code, "DEVICE_ASSIGNMENT_INVALID");
    }
    assert.equal((await a.f.application.sessions.list()).length, before);
    // An access that grants nothing is fine for any session.
    const shell = await start({ accountId: "local-shell", deviceAccess: none });
    assert.equal(shell.status, 201, await shell.clone().text());
    // Sign-in and pipeline sessions get no device.
    const body = { accountId: "local-codex", cwd: a.f.project, deviceAccess: access };
    const ineligible = { code: "DEVICE_SESSION_INELIGIBLE", status: 409 };
    await assert.rejects(a.f.application.launch(body, true), ineligible);
    await assert.rejects(
      a.f.application.launch(body, false, { pipeline: { runId: "r", stepId: "s" } }),
      ineligible,
    );
  },
);

test(
  "a stopped session keeps its entry but can be given nothing new",
  { timeout },
  async (t) => {
    const a = await sessionDevicesApp(t);
    const pixel = await a.device("Pixel");
    const access = { devices: [{ deviceId: pixel.id, manage: false }], create: false };
    const session = await a.launch({ deviceAccess: access });
    const stopped = await a.f.request(`/api/sessions/${session.id}/stop`, {
      method: "POST",
    });
    assert.equal(stopped.status, 200, await stopped.clone().text());
    const shown = await a.access(session);
    assert.equal(shown.eligible, false);
    assert.equal(shown.devices[0].assigned, true);
    assert.deepEqual(
      await json(await a.assign(session, { ...access, create: true })),
      refused("DEVICE_SESSION_INELIGIBLE", 409),
    );
    // Taking it away always works.
    assert.equal((await a.assign(session, none)).status, 200);
    assert.equal((await a.access(session)).devices[0].assigned, false);
  },
);

test(
  "a removed session and a removed device leave no assignment",
  { timeout },
  async (t) => {
    const a = await sessionDevicesApp(t);
    const pixel = await a.device("Pixel");
    const tablet = await a.device("Tablet");
    const access = {
      devices: [
        { deviceId: pixel.id, manage: true },
        { deviceId: tablet.id, manage: false },
      ],
      create: true,
    };
    const session = await a.launch({ deviceAccess: access });
    const caller = { kind: "session", id: session.id, name: session.name };
    // A device the session created is its own.
    const own = await a.devices.create({ name: "Scratch", creator: caller });
    assert.equal((await a.access(session)).devices[2].own, true);
    assert.equal((await a.access(session)).devices[2].manage, true);
    assert.equal(a.devices.device(own.id).creator.gone, false);
    // The device goes: its grant goes with it.
    assert.equal(
      (await a.f.request(`/api/devices/${tablet.id}`, { method: "DELETE" })).status,
      204,
    );
    assert.deepEqual(a.f.application.sessionDeviceGrants.get(session), {
      devices: [{ deviceId: pixel.id, manage: true }],
      create: true,
    });
    // The session goes: the list no longer names it, and its device shows that.
    await a.f.request(`/api/sessions/${session.id}/stop`, { method: "POST" });
    const live = openLive(a.f);
    t.after(() => live.ws.close());
    await live.next((frame) => frame.type === "hello");
    live.send({ op: "sub", topic: "devices" });
    await live.next((frame) => frame.topic === "devices");
    const pushed = live.next(
      (frame) =>
        frame.topic === "devices" &&
        frame.data?.devices.find((device) => device.id === own.id)?.creator.gone === true,
      5000,
    );
    assert.equal(
      (await a.f.request(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
      204,
    );
    const view = (await pushed).data;
    assert.deepEqual(
      view.devices.find((device) => device.id === pixel.id).assignments,
      [],
    );
    assert.deepEqual(view.devices.find((device) => device.id === own.id).creator, {
      kind: "session",
      id: session.id,
      name: session.name,
      gone: true,
    });
    assert.deepEqual(a.devices.permission(caller, pixel.id), {
      use: false,
      manage: false,
    });
    assert.equal(a.f.application.sessionDeviceGrants.canCreate(session.id), false);
    live.ws.close();
  },
);

test(
  "both live topics push an assignment and a device's state",
  { timeout },
  async (t) => {
    const a = await sessionDevicesApp(t);
    const pixel = await a.device("Pixel");
    const session = await a.launch();
    const topic = `session.devices:${session.id}`;
    const live = openLive(a.f);
    t.after(() => live.ws.close());
    await live.next((frame) => frame.type === "hello");
    live.send({ op: "sub", topic });
    live.send({ op: "sub", topic: "devices" });
    const first = await live.next((frame) => frame.topic === topic, 5000);
    assert.equal(first.type, "snapshot");
    assert.deepEqual(first.data, await a.access(session));
    await live.next((frame) => frame.topic === "devices", 5000);
    const own = live.next(
      (frame) => frame.topic === topic && frame.data?.devices[0].assigned === true,
      5000,
    );
    const list = live.next(
      (frame) =>
        frame.topic === "devices" && frame.data?.devices[0].assignments.length === 1,
      5000,
    );
    await a.assign(session, {
      devices: [{ deviceId: pixel.id, manage: false }],
      create: false,
    });
    assert.deepEqual((await own).data, await a.access(session));
    assert.equal((await list).data.devices[0].assignments[0].id, session.id);
    // A device that starts shows in the session's value as well.
    const running = live.next(
      (frame) => frame.topic === topic && frame.data?.devices[0].state === "running",
      20000,
    );
    await a.f.request(`/api/devices/${pixel.id}/start`, { method: "POST" });
    assert.equal((await running).data.devices[0].state, "running");
    live.ws.close();
  },
);

test("a session's device access is the owner's alone", { timeout }, async (t) => {
  const a = await sessionDevicesApp(t);
  const pixel = await a.device("Pixel");
  const session = await a.launch();
  assert.equal((await fetch(a.f.url + a.route(session))).status, 401);
  const { cookie } = await signedInUser(a.f);
  for (const method of ["GET", "PUT"]) {
    const response = await a.f.request(a.route(session), {
      method,
      headers: { cookie },
      ...(method === "PUT" && {
        body: { devices: [{ deviceId: pixel.id, manage: true }], create: true },
      }),
    });
    assert.equal(response.status, 404, method);
    assert.equal(JSON.stringify(await response.json()).includes("DEVICE"), false);
  }
  assert.deepEqual(a.f.application.sessionDeviceGrants.get(session), none);
  const topic = sessionDevicesTopic(a.f.application);
  assert.equal(topic.authorize({ role: "owner" }), true);
  assert.equal(topic.authorize({ role: "user" }), false);
  assert.equal(topic.authorize(null), false);
  assert.equal(liveGate({ role: "user" }, topic.name), false);
  assert.equal(userMayWatch(topic.name), false);
  const live = openLive(a.f, cookie);
  t.after(() => live.ws.close());
  await live.next((frame) => frame.type === "hello");
  const name = `session.devices:${session.id}`;
  live.send({ op: "sub", topic: name });
  assert.deepEqual(await live.next((frame) => frame.topic === name), {
    type: "error",
    topic: name,
    code: "unknown-topic",
  });
  live.ws.close();
});
