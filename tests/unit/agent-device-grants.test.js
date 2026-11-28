import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDeviceGrants,
  WORKSPACE_MISPLACED,
} from "../../server/features/devices/agent-device-grants.js";
import { AREA_CHANGED } from "../../server/features/devices/host-area.js";

// Which devices an agent was assigned and whether it may create devices
// (agent-device-grants.js).
const A = "d-0000000000a1";
const B = "d-0000000000b2";
const ONE = "11111111-1111-4111-8111-111111111111";
const TWO = "22222222-2222-4222-8222-222222222222";
const invalid = { code: "DEVICE_ASSIGNMENT_INVALID", status: 400 };

// A data folder and the agents the assistant store would know.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-device-grants-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const agents = new Map([
    [ONE, { id: ONE, name: "Scout" }],
    [TWO, { id: TWO, name: "Ada" }],
  ]);
  const state = { readable: true };
  const logged = [];
  const clock = { now: 1000 };
  const open = () => {
    const grants = new AgentDeviceGrants({
      dataDir,
      now: () => clock.now,
      log: (line) => logged.push(line),
      agent: (id) => {
        if (!state.readable) throw Error("store closed");
        return agents.get(id) ?? null;
      },
      eligible: (agent) => !agent.archivedAt && !agent.userAccess,
    });
    const changes = { count: 0 };
    grants.onChange = () => changes.count++;
    return { grants, changes };
  };
  const file = path.join(dataDir, "devices", "agent-grants.json");
  return { dataDir, agents, state, file, logged, clock, open, ...open() };
}
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

test("an access is stored for its agent, read back, and survives a restart", (t) => {
  const { grants, changes, open, file } = fixture(t);
  assert.deepEqual(grants.get(ONE), { devices: [], create: false });
  assert.deepEqual(grants.grantsOf(ONE), []);
  assert.equal(grants.canCreate(ONE), false);
  const access = {
    devices: [
      { deviceId: A, manage: true },
      { deviceId: B, manage: false },
    ],
    create: true,
  };
  assert.deepEqual(grants.set(ONE, access), access);
  assert.deepEqual(grants.grantsOf(ONE), access.devices);
  assert.equal(grants.canCreate(ONE), true);
  assert.deepEqual(grants.grantsOf(TWO), []);
  assert.equal(changes.count, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = open().grants;
  assert.deepEqual(again.get(ONE), access);
  // Nothing left removes the entry and, with the last one, the file.
  grants.set(ONE, { devices: [], create: false });
  assert.equal(fs.existsSync(file), false);
  // A damaged file grants nothing.
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(open().grants.grantsOf(ONE), []);
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, agents: { [ONE]: { devices: "x" } } }),
  );
  assert.deepEqual(open().grants.grantsOf(ONE), []);
});

test("only a well-formed access is taken", (t) => {
  const { grants } = fixture(t);
  for (const access of [
    null,
    [],
    { devices: [] },
    { create: true },
    { devices: [], create: "yes" },
    { devices: [], create: false, extra: 1 },
    { devices: [{ deviceId: A }], create: false },
    { devices: [{ deviceId: "pixel", manage: true }], create: false },
    { devices: [{ deviceId: A, manage: true, name: "x" }], create: false },
    {
      devices: [
        { deviceId: A, manage: true },
        { deviceId: A, manage: false },
      ],
      create: false,
    },
    {
      devices: Array.from({ length: 21 }, (_, n) => ({
        deviceId: `d-${String(n).padStart(12, "0")}`,
        manage: false,
      })),
      create: false,
    },
  ])
    assert.throws(() => grants.set(ONE, access), invalid, JSON.stringify(access));
  assert.throws(() => grants.set("../x", { devices: [], create: true }), invalid);
  assert.deepEqual(grants.get(ONE), { devices: [], create: false });
});

test("an entry counts only while its agent exists and can be given devices", (t) => {
  const { grants, agents, state } = fixture(t);
  const access = { devices: [{ deviceId: A, manage: true }], create: true };
  grants.set(ONE, access);
  // An agent that became one of restricted users, or was archived: nothing counts,
  // and the owner still reads what was set.
  agents.set(ONE, { id: ONE, name: "Scout", userAccess: { mode: "shared" } });
  assert.deepEqual([grants.grantsOf(ONE), grants.canCreate(ONE)], [[], false]);
  assert.equal(grants.eligible(ONE), false);
  assert.deepEqual(grants.get(ONE), access);
  agents.set(ONE, { id: ONE, name: "Scout", archivedAt: "2026-11-28" });
  assert.deepEqual(grants.grantsOf(ONE), []);
  agents.set(ONE, { id: ONE, name: "Scout" });
  assert.deepEqual(grants.grantsOf(ONE), access.devices);
  // Agents that cannot be read at all grant nothing, but still exist.
  state.readable = false;
  assert.deepEqual([grants.grantsOf(ONE), grants.canCreate(ONE)], [[], false]);
  assert.equal(grants.exists(ONE), true);
  state.readable = true;
  // A deleted agent is gone, with whatever its entry says.
  agents.delete(ONE);
  assert.equal(grants.exists(ONE), false);
  assert.deepEqual(grants.grantsOf(ONE), []);
  assert.deepEqual(grants.assignmentsOf(A), []);
  assert.equal(grants.exists("not-an-agent"), false);
});

test("a device's assignments name the agents as they are called now", (t) => {
  const { grants, agents } = fixture(t);
  grants.set(ONE, { devices: [{ deviceId: A, manage: false }], create: false });
  grants.set(TWO, { devices: [{ deviceId: A, manage: true }], create: false });
  agents.set(ONE, { id: ONE, name: "Zed" });
  assert.deepEqual(grants.assignmentsOf(A), [
    { kind: "agent", id: TWO, name: "Ada", manage: true },
    { kind: "agent", id: ONE, name: "Zed", manage: false },
  ]);
  assert.deepEqual(grants.assignmentsOf(B), []);
});

test("a removed device and a deleted agent leave no entry", (t) => {
  const { grants, changes, agents, file, open } = fixture(t);
  grants.set(ONE, {
    devices: [
      { deviceId: A, manage: true },
      { deviceId: B, manage: false },
    ],
    create: false,
  });
  grants.set(TWO, { devices: [{ deviceId: A, manage: false }], create: false });
  changes.count = 0;
  grants.dropDevice(A);
  assert.deepEqual(grants.get(ONE).devices, [{ deviceId: B, manage: false }]);
  assert.deepEqual(grants.get(TWO), { devices: [], create: false });
  assert.equal(changes.count, 1);
  grants.dropDevice(A);
  assert.equal(changes.count, 1, "nothing changed, nothing announced");
  agents.delete(ONE);
  grants.discard(ONE);
  assert.equal(changes.count, 2);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(open().grants.get(ONE), { devices: [], create: false });
  // Always announced: a device the agent created shows that its creator is gone.
  grants.discard(ONE);
  assert.equal(changes.count, 3);
});

test("a change that cannot be stored changes nothing", (t) => {
  const { grants, changes, open, file } = fixture(t);
  const given = { devices: [{ deviceId: A, manage: true }], create: true };
  grants.set(ONE, given);
  const stored = fs.readFileSync(file, "utf8");
  const disk = fullDisk(t);
  changes.count = 0;
  // Taking the access away fails as a whole: it is not gone in memory only, to come
  // back with the next start; and nothing is given in memory only either.
  assert.throws(() => grants.set(ONE, { devices: [], create: false }));
  assert.throws(() => grants.set(ONE, { devices: [], create: true }));
  assert.throws(() => grants.set(TWO, given));
  assert.throws(() => grants.dropDevice(A));
  assert.deepEqual(grants.get(ONE), given);
  assert.deepEqual(grants.grantsOf(ONE), given.devices);
  assert.equal(grants.canCreate(ONE), true);
  assert.deepEqual(grants.grantsOf(TWO), []);
  assert.equal(changes.count, 0);
  // A deleted agent's entry that cannot be tidied away never fails the deletion.
  const logged = t.mock.method(console, "error", () => {});
  assert.doesNotThrow(() => grants.discard(ONE));
  assert.equal(logged.mock.callCount(), 1);
  assert.doesNotMatch(String(logged.mock.calls[0].arguments[0]), new RegExp(ONE));
  disk.free();
  assert.equal(fs.readFileSync(file, "utf8"), stored);
  assert.deepEqual(open().grants.get(ONE), given);
});

test("the workspace is recorded as one folder and never silently replaced", (t) => {
  const { grants, dataDir, open, changes } = fixture(t);
  const workspace = path.join(dataDir, "workspaces", ONE);
  fs.mkdirSync(workspace, { recursive: true });
  // Without a folder there is no area, and nothing is recorded.
  assert.equal(grants.area(TWO, path.join(dataDir, "workspaces", TWO)), null);
  // The first use records the folder as it is then (a member with a passed device
  // has no entry of its own).
  const area = grants.area(ONE, workspace);
  assert.equal(area.path, fs.realpathSync(workspace));
  assert.equal(typeof area.dev, "string");
  assert.equal(typeof area.ino, "string");
  assert.equal(changes.count, 0, "nothing the owner sees changed");
  assert.deepEqual(open().grants.area(ONE, workspace), area);
  assert.deepEqual(grants.get(ONE), { devices: [], create: false });
  // A save while that folder is still the workspace leaves the record as it is.
  const access = { devices: [{ deviceId: A, manage: false }], create: false };
  grants.set(ONE, access, { workspace });
  assert.deepEqual(grants.area(ONE, workspace), area);
  // Another folder at that path later is not taken over by a use: it is refused.
  const changed = { code: "DEVICE_PATH_OUTSIDE", status: 403, detail: AREA_CHANGED };
  fs.renameSync(workspace, `${workspace}.moved`);
  assert.throws(() => grants.area(ONE, workspace), changed, "gone");
  fs.mkdirSync(workspace);
  assert.throws(() => grants.area(ONE, workspace), changed, "replaced");
  assert.notEqual(String(fs.statSync(workspace).ino), area.ino);
  assert.equal(open().grants.entries.get(ONE).area.ino, area.ino);
  // The owner saving the agent's devices records the folder that is there now.
  grants.set(ONE, access, { workspace });
  assert.equal(grants.area(ONE, workspace).ino, String(fs.statSync(workspace).ino));
  // Taking everything away keeps the record of the folder.
  grants.set(ONE, { devices: [], create: false });
  assert.equal(grants.area(ONE, workspace).ino, String(fs.statSync(workspace).ino));
});

test("only the workspace folder itself, at its place, is ever recorded", (t) => {
  const { grants, dataDir, open } = fixture(t);
  const misplaced = {
    code: "DEVICE_PATH_OUTSIDE",
    status: 403,
    detail: WORKSPACE_MISPLACED,
  };
  const access = { devices: [{ deviceId: A, manage: false }], create: false };
  // OpenClaw's and AgentPier-made Hermes agents' layout, and a Hermes agent with an
  // id of its own (hermes-paths.js hermesWorkspace): one folder per agent below a
  // workspaces folder.
  const roots = [
    path.join(dataDir, "assistants", "workspaces"),
    path.join(dataDir, "assistants", "hermes", "workspaces"),
  ];
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-device-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  for (const root of roots) {
    fs.mkdirSync(root, { recursive: true });
    const workspace = path.join(root, ONE);
    const none = () => {
      assert.throws(() => grants.area(ONE, workspace), misplaced, root);
      grants.set(ONE, access, { workspace });
      assert.equal(grants.entries.get(ONE).area, null, root);
      assert.equal(open().grants.entries.get(ONE).area, null, root);
    };
    // A link to AgentPier's data folder, to the devices' folder, to a folder
    // elsewhere, to a sibling's workspace, and one that leads nowhere.
    fs.mkdirSync(path.join(root, TWO));
    for (const target of [
      dataDir,
      path.join(dataDir, "devices"),
      outside,
      path.join(root, TWO),
      path.join(root, "missing"),
    ]) {
      fs.symlinkSync(target, workspace);
      none();
      fs.rmSync(workspace);
    }
    // A file in its place.
    fs.writeFileSync(workspace, "x");
    none();
    fs.rmSync(workspace);
    // The folder itself.
    fs.mkdirSync(workspace);
    assert.equal(grants.area(ONE, workspace).path, fs.realpathSync(workspace));
    grants.set(ONE, { devices: [], create: false });
    grants.entries.delete(ONE);
    fs.rmSync(workspace, { recursive: true });
    fs.rmSync(path.join(root, TWO), { recursive: true });
  }
  // A workspaces folder that is itself the data folder or the devices' folder
  // (a wrong path, or a link above) names no workspace either.
  for (const workspace of [dataDir, path.dirname(dataDir), path.join(dataDir, "devices")])
    assert.throws(() => grants.area(TWO, workspace), misplaced, workspace);
  fs.mkdirSync(path.join(dataDir, "devices", TWO), { recursive: true });
  assert.throws(
    () => grants.area(TWO, path.join(dataDir, "devices", TWO)),
    misplaced,
    "below the devices' folder",
  );
  // A record of a folder elsewhere, as an earlier version could have written it,
  // is refused at every use and replaced by the owner's next save.
  const workspace = path.join(roots[0], ONE);
  fs.mkdirSync(workspace);
  const stat = fs.statSync(dataDir, { bigint: true });
  grants.entries.set(ONE, {
    ...access,
    area: {
      path: fs.realpathSync(dataDir),
      dev: String(stat.dev),
      ino: String(stat.ino),
    },
  });
  assert.throws(() => grants.area(ONE, workspace), {
    code: "DEVICE_PATH_OUTSIDE",
    detail: AREA_CHANGED,
  });
  grants.set(ONE, access, { workspace });
  assert.equal(grants.area(ONE, workspace).path, fs.realpathSync(workspace));
});

test("a listener that fails does not undo the change", (t) => {
  const { grants } = fixture(t);
  grants.onChange = () => {
    throw Error("topic gone");
  };
  t.mock.method(console, "error", () => {});
  grants.set(ONE, { devices: [], create: true });
  assert.equal(grants.canCreate(ONE), true);
});

const asides = (file) =>
  fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(`${path.basename(file)}.damaged-`))
    .sort();

test("a damaged file is kept aside and logged once, before a change replaces it", (t) => {
  const f = fixture(t);
  const file = path.join(f.dataDir, "devices", "agent-grants.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A missing file is no damage.
  f.logged.length = 0;
  f.open();
  assert.deepEqual([f.logged, asides(file)], [[], []]);
  const contents = [
    "{ not json",
    "[]",
    JSON.stringify({ version: 1, agents: [] }),
    // One entry of another shape beside a sound one: nothing of it is lost either.
    JSON.stringify({
      version: 1,
      agents: {
        "11111111-1111-4111-8111-111111111111": {
          devices: [{ deviceId: A, manage: true }],
          create: false,
          area: null,
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
    // The sound entries count, and the file is written anew from them, so the next
    // start finds nothing damaged.
    assert.equal(grants.entries.size, index === 3 ? 1 : 0, content);
    assert.equal(fs.existsSync(file), index === 3, content);
    f.logged.length = 0;
    assert.equal(f.open().grants.entries.size, index === 3 ? 1 : 0);
    assert.deepEqual(f.logged, []);
    assert.equal(asides(file).at(-1), kept);
  }
  // Another damaged file at the same moment is kept as a copy of its own.
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
  // Nothing was written over the file that has no copy.
  assert.equal(fs.readFileSync(file, "utf8"), "{ again");
});
