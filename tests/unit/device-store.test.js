import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("a damaged file reads as empty, and records that are none are left out", (t) => {
  const { dataDir, file, read } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const content of ["{ not json", "[]", '{"version":1,"devices":"none"}', "null"]) {
    fs.writeFileSync(file, content);
    assert.deepEqual(new DeviceStore({ dataDir }).list(), [], content);
  }
  const good = new DeviceStore({ dataDir }).add({ name: "Good", creator: owner, image });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      devices: [
        good,
        { ...good, id: "../../etc" },
        { ...good, id: "d-aaaaaaaaaaaa", name: "" },
        { ...good, id: "d-bbbbbbbbbbbb", creator: null },
        "text",
      ],
    }),
  );
  assert.deepEqual(new DeviceStore({ dataDir }).list(), [good]);
  assert.equal(read().devices.length, 5);
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
