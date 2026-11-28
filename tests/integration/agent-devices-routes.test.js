import test from "node:test";
import assert from "node:assert/strict";
import { devicesApp } from "../helpers/devices-app.js";
import { openLive } from "../helpers/live-socket.js";
import { signedInUser } from "../helpers/users.js";
import { liveGate } from "../../server/application/live-wiring.js";
import { agentDevicesTopic } from "../../server/features/devices/agent-device-access.js";
import { userMayWatch } from "../../server/http/route-access.js";

// The owner assigns Android devices to an agent (routes/agent-devices.js), on an
// application with agents on whose devices run on the fake SDK.
const timeout = 60000;
const model = { connectionId: "c", modelId: "m" };
const json = async (response) => ({
  status: response.status,
  body: await response.json(),
});
const refused = (code, status) => ({ status, body: { code, error: code } });
const none = { devices: [], create: false };

async function fixture(t) {
  const a = await devicesApp(t, { assistants: true });
  const { store } = a.f.application.assistants;
  const route = (agent) => `/api/assistants/${agent.id}/devices`;
  return {
    ...a,
    store,
    route,
    grants: a.f.application.agentDeviceGrants,
    agent: (name = "Scout", options) => store.createAssistant({ name, model }, options),
    async device(name = "Pixel") {
      const response = await a.f.request("/api/devices", {
        method: "POST",
        body: { name },
      });
      assert.equal(response.status, 201);
      return response.json();
    },
    access: async (agent) => (await a.f.request(route(agent))).json(),
    assign: (agent, body) => a.f.request(route(agent), { method: "PUT", body }),
  };
}

test("GET and PUT answer an agent's device access", { timeout }, async (t) => {
  const a = await fixture(t);
  const pixel = await a.device("Pixel");
  const tablet = await a.device("Tablet");
  const scout = a.agent();
  const first = await a.f.request(a.route(scout));
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
    passed: false,
    ...extra,
  });
  const value = (extra = {}) => ({
    availability: { available: true, reason: null },
    eligible: true,
    create: false,
    devices: [row(pixel), row(tablet)],
    ...extra,
  });
  assert.deepEqual(await first.json(), value());
  const saved = await a.assign(scout, {
    devices: [{ deviceId: pixel.id, manage: true }],
    create: true,
  });
  assert.deepEqual(await json(saved), {
    status: 200,
    body: value({
      create: true,
      devices: [row(pixel, { assigned: true, manage: true }), row(tablet)],
    }),
  });
  // The device list names the agent, and the device service lets it in.
  const view = await (await a.f.request("/api/devices")).json();
  assert.deepEqual(view.devices[0].assignments, [
    { kind: "agent", id: scout.id, name: "Scout", manage: true },
  ]);
  const caller = { kind: "agent", id: scout.id };
  assert.deepEqual(a.devices.permission(caller, pixel.id), { use: true, manage: true });
  assert.deepEqual(a.devices.permission(caller, tablet.id), {
    use: false,
    manage: false,
  });
  // A device the agent created is its own without a grant.
  const own = await a.devices.create({
    name: "Own",
    creator: { kind: "agent", id: scout.id, name: "Scout" },
  });
  assert.deepEqual(
    (await a.access(scout)).devices.find((device) => device.id === own.id),
    {
      id: own.id,
      name: "Own",
      state: "stopped",
      creator: { kind: "agent", id: scout.id, name: "Scout", gone: false },
      assigned: false,
      manage: true,
      own: true,
      passed: false,
    },
  );
  // Taking everything away again.
  assert.deepEqual((await json(await a.assign(scout, none))).body.create, false);
  assert.deepEqual(a.grants.get(scout.id), none);
  // A deleted device leaves no grant behind.
  await a.assign(scout, {
    devices: [{ deviceId: tablet.id, manage: false }],
    create: false,
  });
  assert.equal(
    (await a.f.request(`/api/devices/${tablet.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.deepEqual(a.grants.get(scout.id), none);
});

test(
  "only a well-formed access for an agent of the owner's own is stored",
  { timeout },
  async (t) => {
    const a = await fixture(t);
    const pixel = await a.device("Pixel");
    const scout = a.agent();
    const invalid = refused("DEVICE_ASSIGNMENT_INVALID", 400);
    for (const body of [
      undefined,
      {},
      { devices: [] },
      { devices: [{ deviceId: pixel.id }], create: false },
      { devices: [{ deviceId: pixel.id, manage: true }], create: false, more: 1 },
      { devices: [{ deviceId: "d-000000000000", manage: false }], create: false },
      {
        devices: [
          { deviceId: pixel.id, manage: true },
          { deviceId: pixel.id, manage: false },
        ],
        create: false,
      },
    ])
      assert.deepEqual(
        await json(await a.assign(scout, body)),
        invalid,
        JSON.stringify(body),
      );
    assert.deepEqual(a.grants.get(scout.id), none);
    // An agent of restricted users, an archived agent and one with a bot for others.
    const access = { devices: [{ deviceId: pixel.id, manage: false }], create: false };
    const ineligible = refused("DEVICE_AGENT_INELIGIBLE", 409);
    const hers = a.agent("Her agent", {
      userAccess: { mode: "own", members: [{ userId: "user-1", level: "chat" }] },
    });
    assert.equal((await a.access(hers)).eligible, false);
    assert.deepEqual(await json(await a.assign(hers, access)), ineligible);
    assert.deepEqual(
      await json(await a.assign(hers, { devices: [], create: true })),
      ineligible,
    );
    // Nothing can always be stored, so an access can always be taken away.
    assert.equal((await a.assign(hers, none)).status, 200);
    const old = a.agent("Old");
    a.store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
      JSON.stringify({
        ...a.store.storedAssistant(old.id),
        archivedAt: "2026-11-28T10:00:00.000Z",
      }),
      old.id,
    );
    assert.deepEqual(await json(await a.assign(old, access)), ineligible);
    const senders = a.f.application.assistantTelegramSenders;
    const connected = senders.connected;
    senders.connected = (id) => id === scout.id;
    t.after(() => (senders.connected = connected));
    assert.equal((await a.access(scout)).eligible, false);
    assert.deepEqual(await json(await a.assign(scout, access)), ineligible);
    senders.connected = connected;
    // An agent that became ineligible keeps what the owner set, and it counts for nothing.
    assert.equal((await a.assign(scout, access)).status, 200);
    senders.connected = (id) => id === scout.id;
    assert.equal((await a.access(scout)).devices[0].assigned, true);
    assert.deepEqual(a.devices.permission({ kind: "agent", id: scout.id }, pixel.id), {
      use: false,
      manage: false,
    });
    // An agent that does not exist.
    for (const method of ["GET", "PUT"]) {
      const response = await a.f.request(
        "/api/assistants/00000000-0000-4000-8000-000000000000/devices",
        {
          method,
          ...(method === "PUT" && { body: access }),
        },
      );
      assert.equal(response.status, 404, method);
    }
  },
);

test(
  "an agent's device access is the owner's alone, pushed on every change",
  { timeout },
  async (t) => {
    const a = await fixture(t);
    const pixel = await a.device("Pixel");
    const scout = a.agent();
    assert.equal((await fetch(a.f.url + a.route(scout))).status, 401);
    const { cookie } = await signedInUser(a.f);
    for (const method of ["GET", "PUT"]) {
      const response = await a.f.request(a.route(scout), {
        method,
        headers: { cookie },
        ...(method === "PUT" && {
          body: { devices: [{ deviceId: pixel.id, manage: true }], create: true },
        }),
      });
      assert.equal(response.status, 404, method);
      assert.equal(JSON.stringify(await response.json()).includes("DEVICE"), false);
    }
    assert.deepEqual(a.grants.get(scout.id), none);
    const topic = agentDevicesTopic(a.f.application);
    assert.equal(topic.authorize({ role: "owner" }), true);
    assert.equal(topic.authorize({ role: "user" }), false);
    assert.equal(topic.authorize(null), false);
    assert.equal(liveGate({ role: "user" }, topic.name), false);
    assert.equal(userMayWatch(topic.name), false);
    // The owner's topic follows an assignment and a change of a device.
    const live = openLive(a.f);
    t.after(() => live.ws.close());
    await live.next((frame) => frame.type === "hello");
    const name = `agent.devices:${scout.id}`;
    live.send({ op: "sub", topic: name });
    const start = await live.next((frame) => frame.topic === name);
    assert.equal(start.data.devices[0].assigned, false);
    const assigned = live.next(
      (frame) => frame.topic === name && frame.data?.devices[0]?.assigned === true,
      5000,
    );
    await a.assign(scout, {
      devices: [{ deviceId: pixel.id, manage: false }],
      create: false,
    });
    assert.equal((await assigned).data.create, false);
    const more = live.next(
      (frame) => frame.topic === name && frame.data?.devices.length === 2,
      5000,
    );
    await a.device("Tablet");
    assert.deepEqual(
      (await more).data.devices.map((device) => device.name),
      ["Pixel", "Tablet"],
    );
    live.ws.close();
  },
);

test(
  "a change of an agent's devices is an audit row that names no device",
  { timeout },
  async (t) => {
    const a = await fixture(t);
    const pixel = await a.device("Pixel checkout");
    const scout = a.agent();
    const rows = () =>
      a.f.application.audit
        .list({ action: "assistant.updated" })
        .events.filter((event) => event.details.kind === "device-grants");
    await a.f.request(a.route(scout));
    assert.equal(rows().length, 0, "reading is not audited");
    assert.equal(
      (
        await a.assign(scout, {
          devices: [{ deviceId: pixel.id, manage: true }],
          create: true,
        })
      ).status,
      200,
    );
    const [row] = rows();
    assert.equal(row.resourceType, "assistant");
    assert.equal(row.resourceId, scout.id);
    assert.equal(row.source, "user");
    assert.equal(row.outcome, "success");
    assert.deepEqual(row.details, { kind: "device-grants" });
    // A refused change stores and records nothing.
    assert.equal((await a.assign(scout, { devices: [], create: "yes" })).status, 400);
    assert.equal(rows().length, 1);
    assert.equal(JSON.stringify(rows()).includes("Pixel"), false);
  },
);

test(
  "a device whose creating agent is gone says so, and is never deleted",
  { timeout },
  async (t) => {
    const a = await fixture(t);
    const scout = a.agent();
    const own = await a.devices.create({
      name: "Own",
      creator: { kind: "agent", id: scout.id, name: "Scout" },
    });
    const creator = async () =>
      (await (await a.f.request("/api/devices")).json()).devices.find(
        (device) => device.id === own.id,
      ).creator;
    assert.equal((await creator()).gone, false);
    a.store.db.prepare("DELETE FROM assistants WHERE id=?").run(scout.id);
    a.grants.discard(scout.id);
    assert.deepEqual(await creator(), {
      kind: "agent",
      id: scout.id,
      name: "Scout",
      gone: true,
    });
  },
);
