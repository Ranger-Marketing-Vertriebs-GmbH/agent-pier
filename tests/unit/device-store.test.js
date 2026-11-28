import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture as serviceFixture } from "../helpers/device-service-fixture.js";
import { writeAvd } from "../../server/features/devices/avd-files.js";
import { DeviceStore } from "../../server/features/devices/device-store.js";

// The device records in `<data>/devices/devices.json`.
const image = "android-36-google_apis-r7";
const owner = { kind: "owner", id: "owner", name: "Owner" };

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, "devices", "devices.json");
  return { dataDir, file, read: () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

test("a device gets an id, its creator and a private file", (t) => {
  const { dataDir, file, read } = fixture(t);
  const store = new DeviceStore({ dataDir, now: () => 1700 });
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(file), false);
  const record = store.add({
    name: "  Pixel  ",
    creator: { kind: "session", id: "s1", name: "Fix login", extra: "dropped" },
    image,
  });
  assert.match(record.id, /^d-[a-f0-9]{12}$/);
  assert.deepEqual(record, {
    id: record.id,
    name: "Pixel",
    source: "emulator",
    creator: { kind: "session", id: "s1", name: "Fix login" },
    image,
    provisioned: false,
    createdAt: 1700,
    lastUsedAt: null,
    resetAt: null,
  });
  assert.deepEqual(read(), { version: 1, devices: [record] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(store.get(record.id), record);
  // What the store hands out is a copy.
  store.get(record.id).name = "changed";
  store.list()[0].creator.kind = "owner";
  assert.deepEqual(store.get(record.id), record);
  // Another instance reads the same records.
  assert.deepEqual(new DeviceStore({ dataDir }).list(), [record]);
  assert.throws(() => store.get("d-000000000000"), {
    code: "DEVICE_NOT_FOUND",
    status: 404,
  });
  assert.throws(
    () => store.add({ name: "x", creator: { kind: "robot" }, image }),
    TypeError,
  );
});

test("a name is trimmed, 1 to 40 characters, without control characters, and unique without regard to case", (t) => {
  const { dataDir } = fixture(t);
  const store = new DeviceStore({ dataDir });
  const invalid = { code: "DEVICE_NAME_INVALID", status: 400 };
  for (const name of [
    "",
    "   ",
    "a".repeat(41),
    "tab\there",
    "line\nbreak",
    "bell\u0007",
    7,
    null,
  ])
    assert.throws(
      () => store.add({ name, creator: owner, image }),
      invalid,
      String(name),
    );
  assert.equal(store.list().length, 0);
  const first = store.add({ name: "Ünïcode Phone 📱", creator: owner, image });
  assert.equal(
    store.add({ name: "a".repeat(40), creator: owner, image }).name.length,
    40,
  );
  const taken = { code: "DEVICE_NAME_TAKEN", status: 409 };
  for (const name of ["ünïcode phone 📱", " ÜNÏCODE PHONE 📱 ", "A".repeat(40)])
    assert.throws(() => store.add({ name, creator: owner, image }), taken, name);
  assert.equal(store.list().length, 2);
  // A rename follows the same rules; a device may keep or recase its own name.
  const second = store.add({ name: "Second", creator: owner, image });
  assert.throws(() => store.patch(second.id, { name: "ünïcode PHONE 📱" }), taken);
  assert.throws(() => store.patch(second.id, { name: " " }), invalid);
  assert.equal(store.patch(second.id, { name: " SECOND " }).name, "SECOND");
  assert.equal(store.get(first.id).name, "Ünïcode Phone 📱");
});

test("patch changes the fields that change, remove removes the record", (t) => {
  const { dataDir, read } = fixture(t);
  const store = new DeviceStore({ dataDir, now: () => 5 });
  const a = store.add({ name: "A", creator: owner, image });
  const b = store.add({ name: "B", creator: owner, image });
  const next = store.patch(a.id, {
    image: "android-37-google_apis-r1",
    provisioned: true,
    lastUsedAt: 9,
    resetAt: 8,
  });
  assert.deepEqual(next, {
    ...a,
    image: "android-37-google_apis-r1",
    provisioned: true,
    lastUsedAt: 9,
    resetAt: 8,
  });
  assert.deepEqual(read().devices, [next, b]);
  assert.throws(() => store.patch(a.id, { id: "d-ffffffffffff" }), TypeError);
  assert.throws(() => store.patch(a.id, { creator: owner }), TypeError);
  assert.throws(() => store.patch("d-000000000000", { provisioned: true }), {
    code: "DEVICE_NOT_FOUND",
  });
  store.remove(a.id);
  assert.deepEqual(read().devices, [b]);
  assert.throws(() => store.remove(a.id), { code: "DEVICE_NOT_FOUND", status: 404 });
});

// A device's folder as the emulator source writes it, on `made` (an image id).
function avd(dataDir, id, made = image) {
  writeAvd(
    { avd: path.join(dataDir, "devices", "avd") },
    {
      id,
      image: made,
      abi: "arm64-v8a",
      shape: {
        width: 720,
        height: 1600,
        density: 320,
        cores: 4,
        memoryMb: 2048,
        dataPartition: "6G",
      },
    },
  );
}
const asides = (file) =>
  fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith("devices.json.damaged-"))
    .sort();

test("a damaged file is kept aside and its devices return from their folders", (t) => {
  const { dataDir, file, read } = fixture(t);
  const logged = [];
  const open = (now = () => 7000) =>
    new DeviceStore({ dataDir, now, log: (line) => logged.push(line) });
  const earlier = "android-35-google_apis-r4";
  avd(dataDir, "d-0000000000aa");
  avd(dataDir, "d-0000000000bb", earlier);
  // A folder that is no device's, and a device folder without a readable config.
  fs.mkdirSync(path.join(dataDir, "devices", "avd", "Pixel_9.avd"));
  fs.mkdirSync(path.join(dataDir, "devices", "avd", "d-0000000000cc.avd"));
  fs.writeFileSync(file, "{ not json");
  const store = open();
  assert.deepEqual(
    store.list().map(({ id, name, image: made, creator, source }) => ({
      id,
      name,
      image: made,
      creator,
      source,
    })),
    [
      ["d-0000000000aa", "Recovered device 1", image],
      ["d-0000000000bb", "Recovered device 2", earlier],
      ["d-0000000000cc", "Recovered device 3", "unknown"],
    ].map(([id, name, made]) => ({
      id,
      name,
      image: made,
      creator: { kind: "owner", id: "owner", name: "" },
      source: "emulator",
    })),
  );
  // The damaged file is still there, the new one is written, and the log says so.
  assert.deepEqual(asides(file), ["devices.json.damaged-7000"]);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(file), "devices.json.damaged-7000"), "utf8"),
    "{ not json",
  );
  assert.equal(
    fs.statSync(path.join(path.dirname(file), asides(file)[0])).mode & 0o77,
    0,
  );
  assert.deepEqual(read().devices, store.list());
  assert.equal(logged.length, 1);
  assert.match(logged[0], /devices\.json\.damaged-7000/);
  assert.match(logged[0], /3 /);
  // The owner sees them, can rename and delete them; the next start changes nothing.
  store.patch("d-0000000000aa", { name: "Mine" });
  store.remove("d-0000000000cc");
  const again = open(() => 8000);
  assert.deepEqual(
    again.list().map(({ name }) => name),
    ["Mine", "Recovered device 2"],
  );
  assert.deepEqual(asides(file), ["devices.json.damaged-7000"]);
  assert.equal(logged.length, 1);
  // The images of recovered devices are in use: an update of the SDK keeps them.
  assert.deepEqual(serviceFixture(t, { dataDir }).service.imagesInUse(), [
    image,
    earlier,
  ]);

  // Every other shape that is not a list of devices is damage too.
  for (const [index, content] of [
    "[]",
    '{"version":1,"devices":"none"}',
    "null",
  ].entries()) {
    fs.writeFileSync(file, content);
    const names = open(() => 9000 + index)
      .list()
      .map(({ id }) => id);
    assert.deepEqual(names, ["d-0000000000aa", "d-0000000000bb", "d-0000000000cc"]);
    assert.equal(asides(file).length, 2 + index, content);
  }
  // No file at all is a host without devices: nothing is adopted, nothing kept aside.
  fs.rmSync(file);
  assert.deepEqual(open().list(), []);
  assert.equal(asides(file).length, 4);
  assert.equal(fs.existsSync(file), false);
});

test("records that are none are left out only after the file was kept aside", (t) => {
  const { dataDir, file, read } = fixture(t);
  const logged = [];
  const good = new DeviceStore({ dataDir }).add({ name: "Good", creator: owner, image });
  const before = JSON.stringify({
    version: 1,
    devices: [
      good,
      { ...good, id: "../../etc" },
      { ...good, id: "d-aaaaaaaaaaaa", name: "" },
      { ...good, id: "d-bbbbbbbbbbbb", creator: null },
      "text",
    ],
  });
  fs.writeFileSync(file, before);
  // One of the broken records has its folder: the device returns under a new name.
  avd(dataDir, "d-aaaaaaaaaaaa");
  avd(dataDir, good.id);
  const store = new DeviceStore({
    dataDir,
    now: () => 4000,
    log: (line) => logged.push(line),
  });
  assert.deepEqual(
    store.list().map(({ id, name }) => [id, name]),
    [
      [good.id, "Good"],
      ["d-aaaaaaaaaaaa", "Recovered device 1"],
    ],
  );
  assert.deepEqual(store.get(good.id), good);
  assert.deepEqual(asides(file), ["devices.json.damaged-4000"]);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(file), "devices.json.damaged-4000"), "utf8"),
    before,
  );
  assert.equal(read().devices.length, 2);
  assert.equal(logged.length, 1);
});

test("a damaged file that cannot be kept aside is never overwritten", (t) => {
  const { dataDir, file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  avd(dataDir, "d-0000000000aa");
  const logged = [];
  const store = new DeviceStore({
    dataDir,
    log: (line) => logged.push(line),
    keepAside: () => {
      throw Object.assign(Error("no space"), { code: "ENOSPC" });
    },
  });
  // The devices are shown, but nothing is written over the only copy of the file.
  assert.deepEqual(
    store.list().map(({ name }) => name),
    ["Recovered device 1"],
  );
  assert.throws(() => store.add({ name: "New", creator: owner, image }), {
    code: "ENOSPC",
  });
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be kept aside/);
  assert.deepEqual(asides(file), []);
  // Once the copy succeeds, the write follows it.
  store.keepAside = (from, to) => fs.copyFileSync(from, to);
  store.add({ name: "New", creator: owner, image });
  assert.equal(asides(file).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).devices.length, 2);
});

test("a write is atomic: a failure leaves the file and the store as they were", (t) => {
  const { dataDir, file, read } = fixture(t);
  const store = new DeviceStore({ dataDir });
  const kept = store.add({ name: "Kept", creator: owner, image });
  const before = fs.readFileSync(file, "utf8");
  // The file system refuses the write: a full disk, for example.
  const failing = new DeviceStore({
    dataDir,
    write: () => {
      throw Object.assign(Error("no space"), { code: "ENOSPC" });
    },
  });
  assert.throws(() => failing.add({ name: "Lost", creator: owner, image }), {
    code: "ENOSPC",
  });
  assert.throws(() => failing.patch(kept.id, { provisioned: true }), { code: "ENOSPC" });
  assert.throws(() => failing.remove(kept.id), { code: "ENOSPC" });
  assert.deepEqual(failing.list(), [kept]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  // The real write replaces the file by a rename and leaves nothing temporary, even
  // when the rename fails because something else took the file's place.
  store.add({ name: "Second", creator: owner, image });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["devices.json"]);
  fs.rmSync(file);
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, "occupied"), "");
  assert.throws(() => store.add({ name: "Third", creator: owner, image }));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["devices.json"]);
  assert.equal(store.list().length, 2);
  fs.rmSync(file, { recursive: true });
  store.add({ name: "Third", creator: owner, image });
  assert.equal(read().devices.length, 3);
});
