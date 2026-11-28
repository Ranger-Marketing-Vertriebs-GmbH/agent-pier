import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ACTIONS } from "../../server/features/devices/device-actions.js";
import { actionsFixture, pngHeader, refused } from "../helpers/device-actions-fixture.js";
import { agent, owner, session } from "../helpers/device-service-fixture.js";

// What a session or an agent does with a device (device-actions.js): who may do
// what, and the actions for the screen. On a device source in memory.
const dump = fs.readFileSync(
  new URL("../fixtures/android/ui-dump-settings-search.xml", import.meta.url),
  "utf8",
);
const commands = (f) => f.adb.map(({ args }) => args.join(" "));

test("the actions are the ones the tools name", () => {
  assert.deepEqual(ACTIONS, [
    "list",
    "create",
    "start",
    "stop",
    "reset",
    "delete",
    "screenshot",
    "ui",
    "tap",
    "swipe",
    "key",
    "type",
    "install",
    "push",
    "pull",
    "app_launch",
    "app_stop",
    "apps",
    "open_url",
    "logs",
    "shell",
  ]);
});

test("list shows the caller's devices only, with what it may do", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel", true);
  const tablet = await f.owned("Tablet");
  await f.create("Hidden");
  const own = await f.create("Own", f.caller);
  assert.deepEqual(await f.run("list"), {
    devices: [
      { id: pixel.id, name: "Pixel", state: "stopped", own: false, manage: true },
      { id: tablet.id, name: "Tablet", state: "stopped", own: false, manage: false },
      { id: own.id, name: "Own", state: "stopped", own: true, manage: true },
    ].map((device) => ({ ...device, held: false })),
    canCreate: false,
  });
  f.allow.create = true;
  assert.equal((await f.run("list")).canCreate, true);
  // Another session sees none of them.
  assert.deepEqual(
    await f.actions.run("list", {}, { caller: session("s2"), canCreate: () => false }),
    { devices: [], canCreate: false },
  );
  // A failed device names its code.
  await f.run("start", { device: "Own" });
  f.source.exit(own.id);
  const listed = (await f.run("list")).devices.find((device) => device.id === own.id);
  assert.equal(listed.state, "failed");
  assert.equal(listed.failure, "DEVICE_EXITED");
});

test("only a session or an agent calls an action, and only a known one", async (t) => {
  const f = actionsFixture(t);
  for (const caller of [owner, { kind: "session" }, { kind: "user", id: "u" }, undefined])
    await assert.rejects(
      f.actions.run("list", {}, { caller }),
      refused("DEVICE_FORBIDDEN", 403),
    );
  await assert.rejects(f.run("toString"), refused("DEVICE_FORBIDDEN", 403));
  await assert.rejects(f.run("format"), refused("DEVICE_FORBIDDEN", 403));
  // An agent is a caller like a session.
  assert.deepEqual(await f.actions.run("list", {}, { caller: agent("a1") }), {
    devices: [],
    canCreate: false,
  });
});

test("create needs the permission and makes the device the caller's own", async (t) => {
  const f = actionsFixture(t);
  await assert.rejects(
    f.run("create", { name: "Mine" }),
    refused("DEVICE_CREATE_FORBIDDEN", 403),
  );
  assert.deepEqual(f.source.calls("create"), []);
  f.allow.create = true;
  const { device } = await f.run("create", { name: "Mine" });
  assert.deepEqual(device, {
    id: device.id,
    name: "Mine",
    state: "stopped",
    own: true,
    manage: true,
    held: false,
  });
  assert.deepEqual(f.service.device(device.id).creator, {
    kind: "session",
    id: "s1",
    name: "web checkout",
    gone: false,
  });
  assert.deepEqual(f.audited.at(-1), {
    action: "device.created",
    device: { id: device.id, name: "Mine" },
    caller: { kind: "session", id: "s1" },
  });
  // The service's own refusals pass through.
  await assert.rejects(f.run("create", { name: "Mine" }), refused("DEVICE_NAME_TAKEN"));
  await assert.rejects(
    f.run("create", { name: "" }),
    refused("DEVICE_NAME_INVALID", 400),
  );
  await assert.rejects(f.run("create", {}), refused("DEVICE_NAME_INVALID", 400));
  // Its own device it may reset and delete without a grant.
  await f.run("reset", { device: "Mine" });
  assert.deepEqual(await f.run("delete", { device: device.id }), {
    deleted: { id: device.id, name: "Mine" },
  });
  assert.deepEqual((await f.run("list")).devices, []);
});

test("a device without a grant is forbidden, and nothing reaches it", async (t) => {
  const f = actionsFixture(t);
  const hidden = await f.create("Hidden");
  for (const [action, input] of [
    ["start", {}],
    ["stop", {}],
    ["reset", {}],
    ["delete", {}],
    ["screenshot", {}],
    ["ui", {}],
    ["tap", { x: 1, y: 1 }],
    ["swipe", { scroll: "down" }],
    ["key", { key: "home" }],
    ["type", { text: "x" }],
    ["install", { path: "build/app.apk" }],
    ["push", { path: "build/app.apk", devicePath: "/sdcard/a" }],
    ["pull", { path: "a", devicePath: "/sdcard/a" }],
    ["app_launch", { package: "com.example.app" }],
    ["app_stop", { package: "com.example.app" }],
    ["apps", {}],
    ["open_url", { url: "https://example.com" }],
    ["logs", {}],
    ["shell", { command: "id" }],
  ])
    await assert.rejects(
      f.run(action, { device: hidden.id, ...input }),
      refused("DEVICE_FORBIDDEN", 403),
      action,
    );
  // By its name it is not even known to exist.
  await assert.rejects(
    f.run("ui", { device: "Hidden" }),
    refused("DEVICE_NOT_FOUND", 404),
  );
  for (const device of ["d-000000000000", "", undefined, 7, "x".repeat(101)])
    await assert.rejects(f.run("ui", { device }), refused("DEVICE_NOT_FOUND", 404));
  assert.deepEqual(f.adb, []);
  assert.deepEqual(f.source.calls("start"), []);
  assert.equal(f.state(hidden.id), "stopped");
});

test("reset and delete need the owner's permission for the device", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel");
  await assert.rejects(
    f.run("reset", { device: "Pixel" }),
    refused("DEVICE_FORBIDDEN", 403),
  );
  await assert.rejects(
    f.run("delete", { device: "Pixel" }),
    refused("DEVICE_FORBIDDEN", 403),
  );
  assert.deepEqual(f.source.calls("reset"), []);
  assert.deepEqual(f.source.calls("remove"), []);
  // Using it is allowed.
  assert.equal((await f.run("start", { device: "Pixel" })).device.state, "running");
  assert.equal((await f.run("stop", { device: pixel.id })).device.state, "stopped");
  f.grant("s1", pixel.id, true);
  assert.equal((await f.run("reset", { device: "Pixel" })).device.manage, true);
  await f.run("delete", { device: "Pixel" });
  assert.deepEqual(f.source.calls("remove"), [pixel.id]);
});

test("while the owner holds a device every call on it is refused", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel", true);
  await f.run("start", { device: "Pixel" });
  const hold = f.service.hold(pixel.id, { ms: 60000 });
  for (const [action, input] of [
    ["tap", { x: 1, y: 1 }],
    ["shell", { command: "id" }],
    ["screenshot", {}],
    ["stop", {}],
    ["reset", {}],
    ["delete", {}],
  ])
    await assert.rejects(
      f.run(action, { device: "Pixel", ...input }),
      refused("DEVICE_HELD", 409),
      action,
    );
  assert.deepEqual(f.adb, []);
  assert.equal((await f.run("list")).devices[0].held, true);
  hold.release();
  await f.run("tap", { device: "Pixel", x: 1, y: 1 });
  assert.deepEqual(commands(f), ["shell input tap 1 1"]);
});

test("a call on a stopped device starts it first", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel");
  assert.deepEqual(await f.run("tap", { device: "Pixel", x: 5, y: 6 }), {
    tapped: { x: 5, y: 6 },
  });
  assert.deepEqual(
    f.source.log.filter(([name]) => name !== "create"),
    [
      ["start", pixel.id],
      ["exec", pixel.id, "shell input tap 5 6"],
    ],
  );
  assert.equal(f.state(pixel.id), "running");
  // One argument after `shell`: the device's shell gets the command as it is.
  assert.deepEqual(f.adb[0].args, ["shell", "input tap 5 6"]);
  assert.deepEqual(f.adb[0].options.caller, undefined);
});

test("a screenshot is a PNG with its size, or it is refused", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  const image = Buffer.concat([pngHeader(720, 1600), Buffer.alloc(100, 1)]);
  f.answers(() => ({ stdout: image }));
  const shot = await f.run("screenshot", { device: "Pixel" });
  assert.deepEqual(shot, { image, mimeType: "image/png", width: 720, height: 1600 });
  assert.deepEqual(f.adb[0].args, ["exec-out", "screencap", "-p"]);
  assert.equal(f.adb[0].options.encoding, "buffer");
  assert.equal(f.adb[0].options.maxBytes, 4 * 2 ** 20);
  for (const answer of [
    { stdout: Buffer.from("error: closed") },
    { stdout: Buffer.alloc(0) },
    { stdout: image, truncated: true, code: null },
    { stdout: image, code: 1, stderr: "adb: device offline" },
  ]) {
    f.answers(() => answer);
    await assert.rejects(
      f.run("screenshot", { device: "Pixel" }),
      refused("DEVICE_SCREEN_UNAVAILABLE", 409),
    );
  }
});

test("the overview numbers the elements, and a tap takes a number", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel");
  f.answers((args) => (args[1] === "uiautomator" ? { stdout: dump } : undefined));
  const shown = await f.run("ui", { device: "Pixel" });
  assert.deepEqual(f.adb[0].args, ["exec-out", "uiautomator", "dump", "/dev/tty"]);
  assert.deepEqual(Object.keys(shown), [
    "package",
    "elements",
    "shown",
    "total",
    "truncated",
  ]);
  assert.equal(shown.elements[0], '1 ImageButton desc="Back" [0,48][96,192] clickable');
  assert.equal(shown.shown, 30);
  assert.deepEqual(await f.run("tap", { device: "Pixel", element: 1 }), {
    tapped: { x: 48, y: 120 },
  });
  assert.deepEqual(
    await f.run("tap", { device: pixel.id, element: 3, longPress: true }),
    {
      longPressed: { x: 664, y: 120 },
    },
  );
  assert.deepEqual(commands(f).slice(1), [
    "shell input tap 48 120",
    "shell input swipe 664 120 664 120 800",
  ]);
  // A number the overview did not list.
  await assert.rejects(
    f.run("tap", { device: "Pixel", element: 31 }),
    refused("DEVICE_ELEMENT_STALE", 409),
  );
  // What a screen says of an element's place is checked like a point a caller
  // names: nothing off the screen is listed, and no such number is tapped.
  f.answers((args) =>
    args[1] === "uiautomator"
      ? {
          stdout:
            '<hierarchy><node text="a" bounds="[-500,-500][-100,-100]" />' +
            `<node text="b" bounds="[0,0][${"9".repeat(400)},${"9".repeat(400)}]" />` +
            '<node text="c" bounds="[0,0][10,10]" /></hierarchy>',
        }
      : undefined,
  );
  const odd = await f.run("ui", { device: "Pixel" });
  assert.deepEqual(odd.elements, ['1 View "c" [0,0][10,10]']);
  const before = f.adb.length;
  await assert.rejects(
    f.run("tap", { device: "Pixel", element: 2 }),
    refused("DEVICE_ELEMENT_STALE", 409),
  );
  for (const target of [
    { n: 1, x: -300, y: -300 },
    { n: 1, x: Infinity, y: 5 },
    { n: 1, x: 5, y: 10001 },
    { n: 1, x: 1.5, y: 5 },
  ]) {
    f.actions.remember(f.caller, pixel.id, [target]);
    await assert.rejects(
      f.run("tap", { device: "Pixel", element: 1 }),
      refused("DEVICE_ELEMENT_STALE", 409),
      JSON.stringify(target),
    );
  }
  assert.equal(f.adb.length, before);
});

test("a number is refused without an overview and after a restart or reset", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel", true);
  const tablet = await f.owned("Tablet");
  f.answers((args) => (args[1] === "uiautomator" ? { stdout: dump } : undefined));
  const tap = (device = "Pixel", extra) => f.run("tap", { device, element: 1 }, extra);
  const stale = refused("DEVICE_ELEMENT_STALE", 409);
  // No overview yet: refused, and the stopped device is not started for it.
  await assert.rejects(tap(), stale);
  assert.deepEqual(f.source.calls("start"), []);
  await f.run("ui", { device: "Pixel" });
  await tap();
  // The overview is this caller's and this device's.
  await assert.rejects(tap("Tablet"), stale);
  f.grant("s2", pixel.id);
  await assert.rejects(
    f.actions.run("tap", { device: "Pixel", element: 1 }, { caller: session("s2") }),
    stale,
  );
  await tap();
  // Stopped and started again: the screen is another one.
  await f.run("stop", { device: "Pixel" });
  await f.run("start", { device: "Pixel" });
  await assert.rejects(tap(), stale);
  await f.run("ui", { device: "Pixel" });
  await tap();
  // The emulator ended by itself.
  f.source.exit(pixel.id);
  await assert.rejects(tap(), stale);
  await f.run("ui", { device: "Pixel" });
  await tap();
  // A reset returns it to the factory state.
  await f.run("reset", { device: "Pixel" });
  await assert.rejects(tap(), stale);
  // Removed: nothing is kept for it.
  await f.run("ui", { device: "Tablet" });
  assert.equal(f.actions.overviews.size, 1);
  await f.service.remove(tablet.id, { caller: owner });
  assert.equal(f.actions.overviews.size, 0);
});

test("a tap is an element or a point, never both or neither", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  const invalid = refused("DEVICE_INPUT_INVALID", 400);
  for (const input of [
    {},
    { element: 1, x: 1, y: 1 },
    { element: 1, x: 1 },
    { x: 1 },
    { y: 1 },
    { element: 0 },
    { element: 1.5 },
    { element: "1" },
    { x: -1, y: 1 },
    { x: 1, y: 10001 },
    { x: 1.5, y: 2 },
  ])
    await assert.rejects(
      f.run("tap", { device: "Pixel", ...input }),
      invalid,
      JSON.stringify(input),
    );
  assert.deepEqual(f.adb, []);
  assert.deepEqual(f.source.calls("start"), []);
});

test("a swipe scrolls by direction or moves between two points", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  f.answers((args) =>
    args[1] === "wm size" ? { stdout: "Physical size: 720x1600\n" } : undefined,
  );
  assert.deepEqual(await f.run("swipe", { device: "Pixel", scroll: "down" }), {
    swiped: { from: { x: 360, y: 1200 }, to: { x: 360, y: 400 } },
  });
  await f.run("swipe", { device: "Pixel", x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 1000 });
  assert.deepEqual(commands(f), [
    "shell wm size",
    "shell input swipe 360 1200 360 400 300",
    "shell input swipe 1 2 3 4 1000",
  ]);
  // An override is the size apps see.
  f.answers((args) =>
    args[1] === "wm size"
      ? { stdout: "Physical size: 720x1600\nOverride size: 400x800\n" }
      : undefined,
  );
  assert.deepEqual((await f.run("swipe", { device: "Pixel", scroll: "left" })).swiped, {
    from: { x: 100, y: 400 },
    to: { x: 300, y: 400 },
  });
  const before = f.adb.length;
  for (const input of [
    {},
    { scroll: "down", x1: 1, y1: 2, x2: 3, y2: 4 },
    { x1: 1, y1: 2, x2: 3 },
    { scroll: "sideways" },
    { scroll: "down", durationMs: 10 },
    { x1: 1, y1: 2, x2: 3, y2: -4 },
  ])
    await assert.rejects(
      f.run("swipe", { device: "Pixel", ...input }),
      refused("DEVICE_INPUT_INVALID", 400),
      JSON.stringify(input),
    );
  assert.equal(f.adb.length, before);
  f.answers(() => ({ stdout: "no size here\n" }));
  await assert.rejects(
    f.run("swipe", { device: "Pixel", scroll: "up" }),
    refused("DEVICE_COMMAND_FAILED", 409),
  );
});

test("keys and text become one checked command each", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  assert.deepEqual(await f.run("key", { device: "Pixel", key: "back" }), {
    pressed: "back",
    count: 1,
  });
  await f.run("key", { device: "Pixel", key: "delete", count: 2 });
  assert.deepEqual(await f.run("type", { device: "Pixel", text: "it's 100%sure; id" }), {
    typed: 17,
  });
  assert.deepEqual(
    f.adb.map(({ args }) => args),
    [
      ["shell", "input keyevent KEYCODE_BACK"],
      ["shell", "input keyevent KEYCODE_DEL KEYCODE_DEL"],
      ["shell", "input text 'it'\\''s 100%' && input text 'sure; id'"],
    ],
  );
  const before = f.adb.length;
  await assert.rejects(
    f.run("type", { device: "Pixel", text: "Grüße" }),
    refused("DEVICE_TEXT_UNSUPPORTED", 400),
  );
  for (const [action, input] of [
    ["type", {}],
    ["type", { text: "" }],
    ["key", {}],
    ["key", { key: "KEYCODE_HOME" }],
    ["key", { key: "home; reboot" }],
    ["key", { key: "home", count: 51 }],
  ])
    await assert.rejects(
      f.run(action, { device: "Pixel", ...input }),
      refused("DEVICE_INPUT_INVALID", 400),
      JSON.stringify(input),
    );
  assert.equal(f.adb.length, before);
});

test("what the device says of a failure is quoted in a few words", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  f.answers(() => ({
    code: 1,
    stdout: "",
    stderr: `adb: device offline\n${"x".repeat(5000)}`,
  }));
  await assert.rejects(f.run("key", { device: "Pixel", key: "home" }), (error) => {
    assert.equal(error.code, "DEVICE_COMMAND_FAILED");
    assert.equal(error.status, 409);
    assert.match(error.detail, /^adb: device offline/);
    assert.ok(error.detail.length <= 402, String(error.detail.length));
    return true;
  });
  // What the service refuses keeps its code.
  f.answers(() => {
    throw Object.assign(Error("DEVICE_ADB_TIMEOUT"), {
      code: "DEVICE_ADB_TIMEOUT",
      status: 409,
    });
  });
  await assert.rejects(
    f.run("key", { device: "Pixel", key: "home" }),
    refused("DEVICE_ADB_TIMEOUT", 409),
  );
});

test("a call ends at its deadline and when its caller is gone", async (t) => {
  const f = actionsFixture(t, { callTimeoutMs: 40 });
  const pixel = await f.owned("Pixel");
  await f.run("start", { device: "Pixel" });
  let release;
  const heard = [];
  f.source.gates.exec = (_record, _args, options) => {
    heard.push(options.signal);
    return new Promise((resolve) => (release = resolve));
  };
  const late = f.run("key", { device: "Pixel", key: "home" });
  // A second call waits behind the first one, and its deadline passes there.
  const queued = f.run("key", { device: "Pixel", key: "back" });
  await assert.rejects(late, refused("DEVICE_CALL_TIMEOUT", 409));
  await assert.rejects(queued, refused("DEVICE_CALL_TIMEOUT", 409));
  // The adb call of the first heard the end of its call; the second never ran.
  assert.equal(heard.length, 1);
  assert.equal(heard[0].aborted, true);
  f.source.gates.exec = null;
  release();
  await f.clock.settle();
  await f.service.adb(pixel.id, ["shell", "true"], { caller: f.caller });
  assert.deepEqual(
    f.adb.map(({ args }) => args.join(" ")),
    ["shell input keyevent KEYCODE_HOME", "shell true"],
  );
  // A caller that is gone before its call began: refused, and nothing is asked.
  const gone = new AbortController();
  gone.abort();
  const before = f.adb.length;
  for (const [action, input] of [
    ["key", { key: "home" }],
    ["start", {}],
    ["stop", {}],
    ["list", {}],
  ])
    await assert.rejects(
      f.run(action, { device: "Pixel", ...input }, { signal: gone.signal }),
      refused("DEVICE_ADB_CANCELLED", 409),
      action,
    );
  assert.equal(f.adb.length, before);
  assert.equal(f.state(pixel.id), "running");
});

test("a caller that is gone starts no device", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel");
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(
    f.run("key", { device: "Pixel", key: "home" }, { signal: gone.signal }),
    refused("DEVICE_ADB_CANCELLED", 409),
  );
  // The service itself starts nothing for a call whose signal has ended, also one
  // that ended while the call waited for its turn.
  await assert.rejects(
    f.service.adb(pixel.id, ["shell", "x"], { caller: f.caller, signal: gone.signal }),
    refused("DEVICE_ADB_CANCELLED", 409),
  );
  assert.deepEqual(f.source.calls("start"), []);
  assert.equal(f.state(pixel.id), "stopped");
  let release;
  f.source.gates.start = () => new Promise((resolve) => (release = resolve));
  const first = f.service.startDevice(pixel.id, { caller: f.caller });
  const leaving = new AbortController();
  const waiting = f.service.adb(pixel.id, ["shell", "x"], {
    caller: f.caller,
    signal: leaving.signal,
  });
  await f.clock.settle();
  leaving.abort();
  release();
  await first;
  await assert.rejects(waiting, refused("DEVICE_ADB_CANCELLED", 409));
  assert.deepEqual(f.source.calls("exec"), []);
});

test("a grant taken away while a device started or stopped answers a refusal", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel", true);
  for (const [action, gate] of [
    ["start", "start"],
    ["stop", "stop"],
    ["reset", "stop"],
  ]) {
    f.grant("s1", pixel.id, true);
    if (action !== "start") await f.run("start", { device: "Pixel" });
    let release;
    f.source.gates[gate] = () => new Promise((resolve) => (release = resolve));
    const running = f.run(action, { device: "Pixel" });
    await f.clock.settle();
    assert.equal(typeof release, "function", action);
    f.revoke("s1");
    f.source.gates[gate] = null;
    release();
    await assert.rejects(running, refused("DEVICE_FORBIDDEN", 403), action);
    await f.service.stopDevice(pixel.id, { caller: { kind: "owner" } });
  }
  // A device that was deleted meanwhile is gone, not forbidden.
  f.grant("s1", pixel.id, true);
  let release;
  f.source.gates.start = () => new Promise((resolve) => (release = resolve));
  const starting = f.run("start", { device: "Pixel" });
  await f.clock.settle();
  const removal = f.service.remove(pixel.id, { caller: { kind: "owner" } });
  release();
  await removal;
  await assert.rejects(starting, (error) => /^DEVICE_/.test(error.code));
});

test("an overview is kept or dropped by the device's state alone", async (t) => {
  const f = actionsFixture(t);
  const pixel = await f.owned("Pixel");
  f.answers((args) => (args.includes("uiautomator") ? { stdout: dump } : undefined));
  await f.run("ui", { device: "Pixel" });
  // No view of a device (with its reads of session files) is built per change. The
  // fixture's own listener reads the whole view; nothing else may.
  let views = 0;
  const { device } = f.service;
  f.service.device = (...args) => (views++, device.apply(f.service, args));
  for (let count = 0; count < 5; count++) f.service.signal();
  f.service.hold(pixel.id, { ms: 1000 }).release();
  assert.equal(views, 0);
  f.service.device = device;
  await f.run("tap", { device: "Pixel", element: 1 });
  await f.run("stop", { device: "Pixel" });
  await assert.rejects(
    f.run("tap", { device: "Pixel", element: 1 }),
    refused("DEVICE_ELEMENT_STALE"),
  );
});
