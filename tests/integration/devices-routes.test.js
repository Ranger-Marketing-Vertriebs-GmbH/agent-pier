import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { devicesApp } from "../helpers/devices-app.js";
import { waitUntil } from "../helpers/fake-android-sdk.js";
import { subscribe } from "../helpers/live-hub-subscriber.js";
import { openLive } from "../helpers/live-socket.js";
import { signedInUser } from "../helpers/users.js";
import { liveGate } from "../../server/application/live-wiring.js";
import {
  deviceInstallationTopic,
  devicesTopic,
} from "../../server/features/devices/live-topics.js";
import { userMayWatch } from "../../server/http/route-access.js";

// The owner's device routes and the two live topics, on an application whose devices
// run on the fake SDK: fake emulator and adb processes, a stand-in download host.
const post = (f, endpoint, body) => f.request(endpoint, { method: "POST", body });
const json = async (response) => ({
  status: response.status,
  body: await response.json(),
});
const refused = (code, status, extra = {}) => ({
  status,
  body: { code, error: code, ...extra },
});
const audited = (f, action) => f.application.audit.list({ action }).events;
const stateOf = (frame, id) =>
  frame.data.devices.find((device) => device.id === id)?.state;

test("the installation routes go from absent through the install to installed", async (t) => {
  const { f, sdk } = await devicesApp(t, { installed: false });
  const first = await f.request("/api/devices/installation");
  assert.equal(first.headers.get("cache-control"), "no-store");
  const absent = await first.json();
  assert.deepEqual(
    [absent.available, absent.reason, absent.state, absent.installed, absent.progress],
    [true, null, "absent", null, null],
  );
  assert.equal(absent.pinned.emulator, "37.3.10");
  assert.ok(absent.pinned.downloadBytes > 0);
  assert.equal(absent.licences[0].id, "android-sdk-license");
  assert.deepEqual(absent.terms, { accepted: false, acceptedAt: null, by: null });
  const view = await (await f.request("/api/devices")).json();
  assert.deepEqual(view.availability, {
    available: false,
    reason: "DEVICES_NOT_INSTALLED",
  });

  // Without the terms nothing starts.
  assert.deepEqual(
    await json(await post(f, "/api/devices/installation/install", {})),
    refused("DEVICES_TERMS_REQUIRED", 400),
  );
  assert.deepEqual(
    await json(await post(f, "/api/devices/installation/install")),
    refused("DEVICES_TERMS_REQUIRED", 400),
  );
  assert.equal(sdk.operation, null);

  const live = subscribe(f.application.live, "devices.installation");
  const devicesLive = subscribe(f.application.live, "devices");
  t.after(() => (live.stop(), devicesLive.stop()));
  await live.next((frame) => frame.type === "snapshot");
  const started = await post(f, "/api/devices/installation/install", {
    acceptTerms: true,
  });
  assert.equal(started.status, 202);
  const running = await started.json();
  assert.ok(["downloading", "unpacking", "checking"].includes(running.state));
  assert.equal(running.terms.by, "owner");
  // A second job is refused while this one runs.
  assert.deepEqual(
    await json(await post(f, "/api/devices/installation/install", { acceptTerms: true })),
    refused("DEVICES_OPERATION_RUNNING", 409),
  );
  assert.deepEqual(
    await json(await post(f, "/api/devices/installation/remove")),
    refused("DEVICES_OPERATION_RUNNING", 409),
  );
  // The topic carries the progress and the end.
  const progress = await live.next(
    (frame) => frame.type === "state" && frame.data.progress?.total > 0,
    20000,
  );
  assert.ok(
    ["emulator", "platformTools", "image"].includes(progress.data.progress.component),
  );
  const done = await live.next(
    (frame) => frame.type === "state" && frame.data.state === "installed",
    20000,
  );
  assert.deepEqual(done.data.installed, {
    emulator: "37.3.10",
    platformTools: "37.0.3",
    images: ["android-36-google_apis-r7"],
  });
  // The device view follows: devices can run now.
  await devicesLive.next((frame) => frame.data?.availability?.available === true, 20000);
  assert.equal(
    (await (await f.request("/api/devices/installation")).json()).state,
    "installed",
  );
  const [row] = audited(f, "tool.installed");
  assert.deepEqual(
    [row.resourceType, row.resourceId, row.source, row.outcome],
    ["tool", "android-devices", "user", "success"],
  );

  // Cancel without a job answers the status; remove takes the SDK away again.
  const cancelled = await json(await post(f, "/api/devices/installation/cancel"));
  assert.deepEqual([cancelled.status, cancelled.body.state], [202, "installed"]);
  const removing = await json(await post(f, "/api/devices/installation/remove"));
  assert.deepEqual([removing.status, removing.body.state], [202, "removing"]);
  await live.next(
    (frame) => frame.type === "state" && frame.data.state === "absent",
    20000,
  );
  assert.equal(audited(f, "tool.deleted").length, 1);
});

test("a cancelled and a failed installation are told apart", async (t) => {
  const { f, fake, sdk } = await devicesApp(t, { installed: false });
  fake.fetchImpl.stall("emulator");
  await post(f, "/api/devices/installation/install", { acceptTerms: true });
  await waitUntil(() => sdk.status().progress?.component === "emulator", {
    describe: "the emulator download",
  });
  const cancelled = await post(f, "/api/devices/installation/cancel");
  assert.equal(cancelled.status, 202);
  await waitUntil(() => !sdk.operation, { describe: "the cancelled job to end" });
  const after = await (await f.request("/api/devices/installation")).json();
  assert.deepEqual(
    [after.state, after.failure, after.requested],
    ["absent", null, false],
  );
  assert.equal(audited(f, "tool.cancelled").length, 1);
  assert.equal(audited(f, "tool.installed").length, 0);

  fake.fetchImpl.reset();
  fake.fetchImpl.corrupt("emulator");
  await post(f, "/api/devices/installation/install", { acceptTerms: true });
  await waitUntil(() => !sdk.operation, { describe: "the failed job to end" });
  const failed = await (await f.request("/api/devices/installation")).json();
  assert.equal(failed.state, "failed");
  assert.match(failed.failure.code, /^DEVICES_[A-Z_]+$/);
  const [row] = audited(f, "tool.installed");
  assert.equal(row.outcome, "failure");
  assert.equal(row.details.code, failed.failure.code);
});

test("create, start, stop, reset and delete answer the documented status codes", async (t) => {
  const { f, fake, devices } = await devicesApp(t);
  const live = subscribe(f.application.live, "devices");
  t.after(() => live.stop());
  const snapshot = await live.next((frame) => frame.type === "snapshot");
  assert.deepEqual(snapshot.data, await (await f.request("/api/devices")).json());
  assert.deepEqual(snapshot.data.availability, { available: true, reason: null });
  assert.deepEqual(snapshot.data.settings, { maxDevices: 5, maxRunning: 2 });
  assert.deepEqual(snapshot.data.counts, { total: 0, running: 0 });

  const created = await post(f, "/api/devices", { name: "  Pixel  " });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const device = await created.json();
  assert.deepEqual(
    [device.name, device.state, device.source, device.failure, device.operation],
    ["Pixel", "stopped", "emulator", null, null],
  );
  assert.deepEqual(device.creator, { kind: "owner", id: "owner", name: "", gone: false });
  assert.deepEqual(device.assignments, []);
  assert.deepEqual(device.image, { id: fake.manifest.image.id, current: true });
  assert.ok(device.diskBytes > 0);
  const at = `/api/devices/${device.id}`;
  assert.deepEqual(
    await json(await post(f, "/api/devices", { name: "pixel" })),
    refused("DEVICE_NAME_TAKEN", 409),
  );
  for (const body of [{ name: "" }, {}, undefined, { name: "x".repeat(41) }])
    assert.deepEqual(
      await json(await post(f, "/api/devices", body)),
      refused("DEVICE_NAME_INVALID", 400),
    );

  // Start answers as soon as the device holds its slot; the topic follows the boot.
  const start = await json(await post(f, `${at}/start`));
  assert.equal(start.status, 202);
  assert.ok(["starting", "running"].includes(start.body.state));
  const booted = await live.next(
    (frame) => frame.type === "state" && stateOf(frame, device.id) === "running",
    20000,
  );
  assert.equal(booted.data.counts.running, 1);
  assert.ok(booted.revision > snapshot.revision);
  assert.equal(fake.emulators().length, 1);
  // Starting a running device answers the same.
  const again = await json(await post(f, `${at}/start`));
  assert.deepEqual([again.status, again.body.state], [202, "running"]);

  // The SDK does not go while a device runs.
  assert.deepEqual(
    await json(await post(f, "/api/devices/installation/remove")),
    refused("DEVICES_IN_USE", 409),
  );
  assert.equal(devices.view().counts.total, 1);

  const stop = await json(await post(f, `${at}/stop`));
  assert.equal(stop.status, 202);
  assert.ok(["stopping", "stopped"].includes(stop.body.state));
  const stopped = await live.next(
    (frame) => frame.type === "state" && stateOf(frame, device.id) === "stopped",
    20000,
  );
  assert.ok(stopped.revision > booted.revision);
  assert.equal(fake.emulators().length, 0);

  const reset = await json(await post(f, `${at}/reset`));
  assert.deepEqual(
    [reset.status, reset.body.state, reset.body.id],
    [202, "stopped", device.id],
  );
  assert.equal(devices.store.get(device.id).provisioned, false);
  assert.ok(devices.store.get(device.id).resetAt > 0);

  const settings = await f.request("/api/devices/settings", {
    method: "PUT",
    body: { maxDevices: 3, maxRunning: 1 },
  });
  assert.deepEqual(await json(settings), {
    status: 200,
    body: { maxDevices: 3, maxRunning: 1 },
  });
  assert.deepEqual(
    await json(
      await f.request("/api/devices/settings", {
        method: "PUT",
        body: { maxRunning: 9 },
      }),
    ),
    refused("DEVICES_SETTINGS_INVALID", 400),
  );

  const deleted = await f.request(at, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  assert.deepEqual((await (await f.request("/api/devices")).json()).devices, []);

  for (const action of ["device.created", "device.reset", "device.deleted"]) {
    const [row] = audited(f, action);
    assert.deepEqual(
      [row.resourceType, row.resourceId, row.source, row.outcome, row.details],
      ["device", device.id, "user", "success", { caller: "owner" }],
      action,
    );
  }
  assert.equal(
    JSON.stringify(f.application.audit.list().events).includes("Pixel"),
    false,
  );
});

test("an unknown device is 404 on every route that names one", async (t) => {
  const { f } = await devicesApp(t);
  for (const [method, endpoint] of [
    ["POST", "/api/devices/d-000000000000/start"],
    ["POST", "/api/devices/d-000000000000/stop"],
    ["POST", "/api/devices/d-000000000000/reset"],
    ["DELETE", "/api/devices/d-000000000000"],
    ["DELETE", "/api/devices/installation"],
  ])
    assert.deepEqual(
      await json(await f.request(endpoint, { method })),
      refused("DEVICE_NOT_FOUND", 404),
      `${method} ${endpoint}`,
    );
});

test("a start beyond the running limit is refused in the answer, with nothing left behind", async (t) => {
  const { f, devices } = await devicesApp(t);
  await f.request("/api/devices/settings", { method: "PUT", body: { maxRunning: 1 } });
  const first = await (await post(f, "/api/devices", { name: "One" })).json();
  const second = await (await post(f, "/api/devices", { name: "Two" })).json();
  assert.equal((await post(f, `/api/devices/${first.id}/start`)).status, 202);
  await waitUntil(() => devices.device(first.id).state === "running", {
    describe: "the first device to run",
  });
  // The first device was used just now, so it does not make room.
  assert.deepEqual(
    await json(await post(f, `/api/devices/${second.id}/start`)),
    refused("DEVICE_LIMIT_RUNNING", 409),
  );
  assert.deepEqual(
    [devices.device(second.id).state, devices.device(second.id).failure],
    ["stopped", null],
  );
  // Removing the installation deletes the devices once none runs.
  assert.equal((await post(f, `/api/devices/${first.id}/stop`)).status, 202);
  await waitUntil(() => devices.device(first.id).state === "stopped", {
    describe: "the first device to stop",
  });
  const removing = await json(await post(f, "/api/devices/installation/remove"));
  assert.equal(removing.status, 202);
  assert.equal(devices.view().counts.total, 0);
  assert.equal(audited(f, "device.deleted").length, 2);
  await waitUntil(() => !f.application.androidSdk.operation, {
    describe: "the removal to end",
  });
  assert.deepEqual(
    await json(await post(f, "/api/devices", { name: "Three" })),
    refused("DEVICE_UNAVAILABLE", 409, { reason: "DEVICES_NOT_INSTALLED" }),
  );
});

test("a boot that fails after the answer shows as the device's failure", async (t) => {
  const { f, fake, devices } = await devicesApp(t);
  const device = await (await post(f, "/api/devices", { name: "Pixel" })).json();
  fake.behaviour({ mode: "die" });
  const start = await json(await post(f, `/api/devices/${device.id}/start`));
  assert.equal(start.status, 202);
  await waitUntil(() => devices.device(device.id).state === "failed", {
    describe: "the failed boot",
  });
  const view = await (await f.request("/api/devices")).json();
  assert.equal(view.devices[0].failure.code, "DEVICE_EXITED");
  assert.equal(view.counts.running, 0);
});

test("devices are for the owner only", async (t) => {
  const { f } = await devicesApp(t);
  assert.equal((await fetch(f.url + "/api/devices")).status, 401);
  const { cookie } = await signedInUser(f);
  for (const [method, endpoint] of [
    ["GET", "/api/devices"],
    ["GET", "/api/devices/installation"],
    ["POST", "/api/devices"],
    ["POST", "/api/devices/installation/install"],
    ["PUT", "/api/devices/settings"],
  ]) {
    const response = await f.request(endpoint, {
      method,
      headers: { cookie },
      ...(method === "GET" ? {} : { body: { name: "Mine", acceptTerms: true } }),
    });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.equal(JSON.stringify(await response.json()).includes("DEVICE"), false);
  }
  assert.equal(f.application.devices.view().counts.total, 0);
  for (const topic of [
    devicesTopic(f.application),
    deviceInstallationTopic(f.application),
  ]) {
    assert.equal(topic.authorize({ role: "owner" }), true);
    assert.equal(topic.authorize({ role: "user" }), false);
    assert.equal(topic.authorize(null), false);
    assert.equal(topic.mode, "state");
    assert.equal(liveGate({ role: "user" }, topic.name), false);
    assert.equal(userMayWatch(topic.name), false);
  }
  const live = openLive(f, cookie);
  await live.next((frame) => frame.type === "hello");
  for (const topic of ["devices", "devices.installation"]) {
    live.send({ op: "sub", topic });
    assert.deepEqual(await live.next((frame) => frame.topic === topic), {
      type: "error",
      topic,
      code: "unknown-topic",
    });
  }
  live.ws.close();
});

test("a host that cannot run devices starts, says why and stops cleanly", async (t) => {
  // The real manifest and wiring, on a platform without an emulator build.
  const spawned = [];
  const f = await applicationFixture(t, {
    androidDevices: {
      host: { platform: "linux", arch: "arm64" },
      source: {
        spawn: (...args) => {
          spawned.push(args);
          throw Error("nothing may be started");
        },
      },
    },
  });
  const view = await (await f.request("/api/devices")).json();
  assert.deepEqual(view.availability, {
    available: false,
    reason: "DEVICES_PLATFORM_UNSUPPORTED",
  });
  const status = await (await f.request("/api/devices/installation")).json();
  assert.deepEqual(
    [status.available, status.reason, status.state],
    [false, "DEVICES_PLATFORM_UNSUPPORTED", "absent"],
  );
  assert.equal(status.pinned.image.abi, null);
  assert.deepEqual(
    await json(await post(f, "/api/devices/installation/install", { acceptTerms: true })),
    refused("DEVICES_PLATFORM_UNSUPPORTED", 409),
  );
  assert.deepEqual(
    await json(await post(f, "/api/devices", { name: "Pixel" })),
    refused("DEVICE_UNAVAILABLE", 409, { reason: "DEVICES_PLATFORM_UNSUPPORTED" }),
  );
  await f.dispose();
  assert.deepEqual(spawned, []);
});
