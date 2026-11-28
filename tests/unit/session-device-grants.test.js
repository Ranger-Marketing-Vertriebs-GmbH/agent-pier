import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionDeviceGrants,
  deviceEligible,
} from "../../server/features/devices/session-device-grants.js";

// Which devices a coding session was assigned and whether it may create devices
// (session-device-grants.js).
const A = "d-0000000000a1";
const B = "d-0000000000b2";
const invalid = { code: "DEVICE_ASSIGNMENT_INVALID", status: 400 };
const running = (extra = {}) => ({
  id: "session-1",
  name: "web checkout",
  createdAt: "2026-11-28T10:00:00.000Z",
  tool: "codex",
  status: "running",
  ...extra,
});

// A data folder with the session files the session manager would have written.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-grants-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sessions = path.join(dataDir, "sessions");
  fs.mkdirSync(sessions);
  const save = (session) => {
    fs.writeFileSync(path.join(sessions, `${session.id}.json`), JSON.stringify(session));
    return session;
  };
  const remove = (id) => fs.rmSync(path.join(sessions, `${id}.json`));
  const logged = [];
  const clock = { now: 1000 };
  const open = () => {
    const grants = new SessionDeviceGrants({
      dataDir,
      now: () => clock.now,
      log: (line) => logged.push(line),
    });
    const changes = { count: 0 };
    grants.onChange = () => changes.count++;
    return { grants, changes };
  };
  return { dataDir, save, remove, logged, clock, open, ...open() };
}

test("an access is stored for its session and read back", (t) => {
  const { grants, changes, save, dataDir } = fixture(t);
  const session = save(running());
  assert.deepEqual(grants.get(session), { devices: [], create: false });
  assert.deepEqual(grants.grantsOf("session-1"), []);
  assert.equal(grants.canCreate("session-1"), false);
  const access = {
    devices: [
      { deviceId: A, manage: true },
      { deviceId: B, manage: false },
    ],
    create: false,
  };
  assert.deepEqual(grants.set(session, access), access);
  assert.deepEqual(grants.get(session), access);
  assert.deepEqual(grants.grantsOf("session-1"), access.devices);
  assert.equal(grants.canCreate("session-1"), false);
  assert.equal(changes.count, 1);
  const file = path.join(dataDir, "devices", "session-grants.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    sessions: {
      "session-1": {
        createdAt: "2026-11-28T10:00:00.000Z",
        name: "web checkout",
        ...access,
      },
    },
  });
  // Only the permission to create, without any device.
  grants.set(session, { devices: [], create: true });
  assert.equal(grants.canCreate("session-1"), true);
  assert.deepEqual(grants.grantsOf("session-1"), []);
  // Nothing at all removes the entry, and the file with the last one.
  assert.deepEqual(grants.set(session, { devices: [], create: false }), {
    devices: [],
    create: false,
  });
  assert.equal(fs.existsSync(file), false);
  assert.equal(changes.count, 3);
  // Taking nothing away from nothing is no change.
  grants.set(session, { devices: [], create: false });
  assert.equal(changes.count, 3);
});

test("the store survives a restart; a damaged file grants nothing", (t) => {
  const f = fixture(t);
  const session = f.save(running());
  f.grants.set(session, { devices: [{ deviceId: A, manage: true }], create: true });
  const again = f.open().grants;
  assert.deepEqual(again.grantsOf("session-1"), [{ deviceId: A, manage: true }]);
  assert.equal(again.canCreate("session-1"), true);
  const file = path.join(f.dataDir, "devices", "session-grants.json");
  for (const content of [
    "{ not json",
    "[]",
    JSON.stringify({ version: 1, sessions: [] }),
    JSON.stringify({
      version: 1,
      sessions: { "session-1": { devices: [{ deviceId: "x" }], create: true } },
    }),
    JSON.stringify({ version: 1, sessions: { "../x": { devices: [], create: true } } }),
  ]) {
    fs.writeFileSync(file, content);
    const { grants } = f.open();
    assert.deepEqual(grants.grantsOf("session-1"), [], content);
    assert.equal(grants.canCreate("session-1"), false, content);
    assert.deepEqual(grants.assignmentsOf(A), []);
  }
});

test("only a well-formed access is taken", (t) => {
  const { grants, save } = fixture(t);
  const session = save(running());
  assert.deepEqual(grants.validate(undefined), { devices: [], create: false });
  for (const access of [
    null,
    [],
    "x",
    {},
    { devices: [] },
    { create: false },
    { devices: [], create: "yes" },
    { devices: {}, create: false },
    { devices: [], create: false, extra: 1 },
    { devices: [{ deviceId: A }], create: false },
    { devices: [{ deviceId: A, manage: "yes" }], create: false },
    { devices: [{ deviceId: A, manage: true, use: true }], create: false },
    { devices: [{ deviceId: "d-1", manage: true }], create: false },
    { devices: [{ deviceId: "../x", manage: true }], create: false },
    { devices: [A], create: false },
    {
      devices: [
        { deviceId: A, manage: true },
        { deviceId: A, manage: false },
      ],
      create: false,
    },
    {
      devices: Array.from({ length: 21 }, (_, index) => ({
        deviceId: `d-${String(index).padStart(12, "0")}`,
        manage: false,
      })),
      create: false,
    },
  ])
    assert.throws(() => grants.set(session, access), invalid, JSON.stringify(access));
  assert.throws(() => grants.set({ id: "../x" }, { devices: [], create: true }), invalid);
  assert.deepEqual(grants.get(session), { devices: [], create: false });
});

test("an entry counts only for the very session it was made for", (t) => {
  const { grants, save, remove } = fixture(t);
  const session = save(running());
  grants.set(session, { devices: [{ deviceId: A, manage: true }], create: true });
  assert.equal(grants.exists("session-1"), true);
  // Another session under the same id: nothing is inherited.
  const other = save(running({ createdAt: "2026-11-29T10:00:00.000Z" }));
  assert.deepEqual(grants.get(other), { devices: [], create: false });
  assert.deepEqual(grants.grantsOf("session-1"), []);
  assert.equal(grants.canCreate("session-1"), false);
  assert.deepEqual(grants.assignmentsOf(A), []);
  // The session itself again; then removed: its file is gone, and so is the grant.
  save(session);
  assert.deepEqual(grants.grantsOf("session-1"), [{ deviceId: A, manage: true }]);
  remove("session-1");
  assert.equal(grants.exists("session-1"), false);
  assert.deepEqual(grants.grantsOf("session-1"), []);
  assert.equal(grants.canCreate("session-1"), false);
  assert.deepEqual(grants.assignmentsOf(A), []);
  for (const id of ["../session-1", "", undefined, "a/b", "x".repeat(81)]) {
    assert.equal(grants.exists(id), false);
    assert.deepEqual(grants.grantsOf(id), []);
  }
});

test("a device's assignments name the sessions as they are called now", (t) => {
  const { grants, save } = fixture(t);
  const first = save(running());
  const second = save(running({ id: "session-2", name: "api tests" }));
  grants.set(first, { devices: [{ deviceId: A, manage: false }], create: false });
  grants.set(second, {
    devices: [
      { deviceId: A, manage: true },
      { deviceId: B, manage: false },
    ],
    create: false,
  });
  assert.deepEqual(grants.assignmentsOf(A), [
    { kind: "session", id: "session-2", name: "api tests", manage: true },
    { kind: "session", id: "session-1", name: "web checkout", manage: false },
  ]);
  assert.deepEqual(grants.assignmentsOf(B), [
    { kind: "session", id: "session-2", name: "api tests", manage: false },
  ]);
  assert.deepEqual(grants.assignmentsOf("d-00000000ffff"), []);
  // Renamed since: the list follows the session's file.
  save({ ...first, name: "checkout v2" });
  assert.equal(grants.assignmentsOf(A)[1].name, "checkout v2");
});

test("a removed device and a removed session leave no entry", (t) => {
  const { grants, changes, save, dataDir } = fixture(t);
  const first = save(running());
  const second = save(running({ id: "session-2" }));
  grants.set(first, { devices: [{ deviceId: A, manage: false }], create: false });
  grants.set(second, {
    devices: [
      { deviceId: A, manage: true },
      { deviceId: B, manage: false },
    ],
    create: true,
  });
  changes.count = 0;
  grants.dropDevice(A);
  assert.equal(changes.count, 1);
  // The first session had nothing else: its entry is gone.
  assert.deepEqual(grants.get(first), { devices: [], create: false });
  assert.deepEqual(grants.get(second), {
    devices: [{ deviceId: B, manage: false }],
    create: true,
  });
  grants.dropDevice("d-00000000ffff");
  assert.equal(changes.count, 1, "nothing changed");
  // A removed session is always announced: a device it created shows it.
  grants.discard("session-2");
  grants.discard("session-9");
  assert.equal(changes.count, 3);
  assert.deepEqual(grants.get(second), { devices: [], create: false });
  assert.equal(
    fs.existsSync(path.join(dataDir, "devices", "session-grants.json")),
    false,
  );
});

// Nothing can be written or removed any more, as on a full or read-only disk.
function fullDisk(t) {
  const fail = () => {
    throw Object.assign(Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  };
  const mocks = ["openSync", "renameSync", "rmSync", "unlinkSync"].map((name) =>
    t.mock.method(fs, name, fail),
  );
  return { free: () => mocks.forEach((mock) => mock.mock.restore()) };
}

test("a change that cannot be stored changes nothing", (t) => {
  const { grants, changes, save, open, dataDir } = fixture(t);
  const session = save(running());
  const other = save(running({ id: "session-2" }));
  const given = { devices: [{ deviceId: A, manage: true }], create: true };
  grants.set(session, given);
  const file = path.join(dataDir, "devices", "session-grants.json");
  const stored = fs.readFileSync(file, "utf8");
  const disk = fullDisk(t);
  changes.count = 0;
  // Taking the access away fails as a whole: it is not gone in memory only, to come
  // back with the next start.
  assert.throws(() => grants.set(session, { devices: [], create: false }));
  assert.throws(() => grants.set(session, { devices: [], create: true }));
  assert.throws(() => grants.set(other, given));
  assert.throws(() => grants.dropDevice(A));
  assert.deepEqual(grants.get(session), given);
  assert.deepEqual(grants.grantsOf("session-1"), given.devices);
  assert.equal(grants.canCreate("session-1"), true);
  assert.deepEqual(grants.get(other), { devices: [], create: false });
  assert.equal(changes.count, 0);
  disk.free();
  assert.equal(fs.readFileSync(file, "utf8"), stored);
  assert.deepEqual(open().grants.get(session), given);
});

test("a removed session never fails on its entry", (t) => {
  const { grants, changes, save, remove, dataDir } = fixture(t);
  const session = save(running());
  const file = path.join(dataDir, "devices", "session-grants.json");
  // Without an entry nothing is written: not even the folder is made.
  grants.discard("session-1");
  grants.discard("session-9");
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.equal(changes.count, 2, "announced all the same");
  grants.set(session, { devices: [{ deviceId: A, manage: false }], create: false });
  const stored = fs.readFileSync(file, "utf8");
  remove("session-1");
  const disk = fullDisk(t);
  const logged = t.mock.method(console, "error", () => {});
  changes.count = 0;
  // The session's removal and a failed launch's cleanup go on after this call.
  assert.doesNotThrow(() => grants.discard("session-1"));
  assert.doesNotThrow(() => grants.discard("session-9"));
  assert.equal(logged.mock.callCount(), 1);
  assert.doesNotMatch(String(logged.mock.calls[0].arguments[0]), /session-1/);
  assert.equal(changes.count, 2);
  disk.free();
  // What could not be tidied away grants nothing: its session is gone.
  assert.equal(fs.readFileSync(file, "utf8"), stored);
  assert.deepEqual(grants.grantsOf("session-1"), []);
  assert.deepEqual(grants.assignmentsOf(A), []);
  // A listener that fails does not make it throw either.
  grants.onChange = () => {
    throw Error("topic gone");
  };
  assert.doesNotThrow(() => grants.discard("session-1"));
});

test("a listener that fails does not undo the change", (t) => {
  const { grants, save } = fixture(t);
  const session = save(running());
  grants.onChange = () => {
    throw Error("topic gone");
  };
  t.mock.method(console, "error", () => {});
  grants.set(session, { devices: [], create: true });
  assert.equal(grants.canCreate("session-1"), true);
});

test("devices go to the owner's running coding sessions only", () => {
  assert.equal(deviceEligible(running()), true);
  for (const tool of ["claude", "opencode"])
    assert.equal(deviceEligible(running({ tool })), true);
  for (const extra of [
    { status: "stopped" },
    { tool: "shell" },
    { purpose: "login" },
    { pipeline: { runId: "r" } },
    { imported: true },
  ])
    assert.equal(deviceEligible(running(extra)), false, JSON.stringify(extra));
  assert.equal(deviceEligible(null), false);
  // A session one of the owner's own agents started is the owner's; one a
  // restricted user's agent started is not.
  const started = running({ startedBy: { kind: "agent", assistantId: "a1", name: "A" } });
  const users = new Set(["a2"]);
  const options = { userAgent: (id) => users.has(id) };
  assert.equal(deviceEligible(started, options), true);
  assert.equal(
    deviceEligible(
      running({ startedBy: { kind: "agent", assistantId: "a2", name: "B" } }),
      options,
    ),
    false,
  );
  assert.equal(deviceEligible(running({ startedBy: { kind: "user" } }), options), false);
  assert.equal(
    deviceEligible(started, {
      userAgent: () => {
        throw Error("agents are off");
      },
    }),
    false,
  );
});

const asides = (file) =>
  fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(`${path.basename(file)}.damaged-`))
    .sort();

test("a damaged file is kept aside and logged once, before a change replaces it", (t) => {
  const f = fixture(t);
  const file = path.join(f.dataDir, "devices", "session-grants.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A missing file is no damage.
  f.logged.length = 0;
  f.open();
  assert.deepEqual([f.logged, asides(file)], [[], []]);
  const contents = [
    "{ not json",
    "[]",
    JSON.stringify({ version: 1, sessions: [] }),
    // One entry of another shape beside a sound one: nothing of it is lost either.
    JSON.stringify({
      version: 1,
      sessions: {
        "session-1": {
          createdAt: "2026-11-28T10:00:00.000Z",
          name: "One",
          devices: [{ deviceId: A, manage: true }],
          create: false,
        },
        "../x": { devices: [], create: true },
      },
    }),
  ];
  for (const [index, content] of contents.entries()) {
    fs.writeFileSync(file, content);
    f.logged.length = 0;
    f.clock.now = 7000 + index;
    const { grants } = f.open();
    const kept = `${path.basename(file)}.damaged-${7000 + index}`;
    assert.equal(asides(file).at(-1), kept, content);
    const aside = path.join(path.dirname(file), kept);
    assert.equal(fs.readFileSync(aside, "utf8"), content);
    assert.equal(fs.statSync(aside).mode & 0o77, 0);
    assert.equal(f.logged.length, 1, content);
    assert.match(f.logged[0], new RegExp(kept.replaceAll(".", "\\.")));
    // Nothing of what the file held reaches the log.
    assert.doesNotMatch(f.logged[0], /not json|d-0000/);
    // The sound entries count; the next change writes a sound file beside the copy.
    assert.equal(grants.entries.size, index === 3 ? 1 : 0, content);
  }
  // A second start on the same damaged file keeps a second copy, never over the first.
  fs.writeFileSync(file, "{ not json");
  f.clock.now = 7000;
  f.open();
  assert.equal(asides(file).length, contents.length + 1);
  // A file that cannot be kept aside is still reported, and grants nothing.
  fs.writeFileSync(file, "{ again");
  f.logged.length = 0;
  const copy = t.mock.method(fs, "copyFileSync", () => {
    throw Object.assign(Error("ENOSPC"), { code: "ENOSPC" });
  });
  const { grants } = f.open();
  copy.mock.restore();
  assert.equal(grants.entries.size, 0);
  assert.equal(f.logged.length, 1);
  assert.match(f.logged[0], /could not be kept/);
});
