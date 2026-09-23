import test from "node:test";
import assert from "node:assert/strict";
import * as fixtures from "../helpers/file-platform.js";

function harness() {
  const image = "/owned/image.sparseimage";
  const directory = "/owned/mount";
  let current = {
    "image-path": image,
    "system-entities": [
      { "dev-entry": "/dev/disk40s1" },
      { "dev-entry": "/dev/disk40", "content-hint": "GUID_partition_scheme" },
      { "dev-entry": "/dev/disk41s1", "mount-point": directory },
    ],
  };
  const commands = [],
    waits = [],
    diagnostics = [];
  let failures = 0;
  const busy = Object.assign(new Error("busy"), {
    code: 16,
    stderr: "Ressource ist belegt",
  });
  const options = {
    image,
    directory,
    identity: "123",
    attached: async () => current,
    stat: async () => ({ dev: 123 }),
    command: async (...args) => {
      commands.push(args);
      if (failures-- > 0) throw busy;
      current = undefined;
    },
    wait: async (delay) => waits.push(delay),
    diagnostic: (value) => diagnostics.push(JSON.parse(value)),
  };
  return {
    options,
    commands,
    waits,
    diagnostics,
    busy,
    set failures(value) {
      failures = value;
    },
    set current(value) {
      current = value;
    },
  };
}

test("owned image detachment tolerates transient busy with fresh ownership checks", async () => {
  const f = harness();
  f.failures = 1;
  await fixtures.detachOwnedDiskImage(f.options);
  assert.deepEqual(f.commands, [
    ["hdiutil", ["detach", "/dev/disk40"]],
    ["hdiutil", ["detach", "/dev/disk40"]],
  ]);
  assert.deepEqual(f.waits, [250]);
  assert.equal(f.diagnostics[0].code, 16);
});

test("persistent busy is bounded and leaves the image attached", async () => {
  const f = harness();
  f.failures = Infinity;
  await assert.rejects(fixtures.detachOwnedDiskImage(f.options), (e) => e === f.busy);
  assert.equal(f.commands.length, 7);
  assert.deepEqual(f.waits, [250, 500, 1000, 2000, 4000, 8000]);
  assert.ok(await f.options.attached());
});

test("non-busy detach failures are never retried", async () => {
  const f = harness();
  f.failures = 1;
  f.busy.code = 5;
  await assert.rejects(fixtures.detachOwnedDiskImage(f.options), (e) => e === f.busy);
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.waits, []);
});

test("changed ownership after busy prevents another detach", async () => {
  const f = harness();
  f.failures = 1;
  // The mount identity is re-observed, not cached from a previous attempt.
  let observations = 0;
  f.options.stat = async () => ({ dev: ++observations === 1 ? 123 : 999 });
  await assert.rejects(fixtures.detachOwnedDiskImage(f.options), {
    code: "ERR_ASSERTION",
  });
  assert.equal(f.commands.length, 1);
});

for (const invalid of ["image", "topology", "mount"]) {
  test(`unproved ${invalid} refuses detachment`, async () => {
    const f = harness();
    const current = await f.options.attached();
    if (invalid === "image") current["image-path"] = "/other/image.sparseimage";
    if (invalid === "topology") current["system-entities"].splice(1, 1);
    if (invalid === "mount") current["system-entities"][2]["mount-point"] = "/other";
    await assert.rejects(fixtures.detachOwnedDiskImage(f.options), {
      code: "ERR_ASSERTION",
    });
    assert.deepEqual(f.commands, []);
  });
}

test("already detached image needs no command", async () => {
  const f = harness();
  f.current = undefined;
  await fixtures.detachOwnedDiskImage(f.options);
  assert.deepEqual(f.commands, []);
});

test("partially unmounted owned image can finish detaching", async () => {
  const f = harness();
  f.failures = 1;
  f.options.wait = async () => {
    const current = await f.options.attached();
    delete current["system-entities"][2]["mount-point"];
  };
  await fixtures.detachOwnedDiskImage(f.options);
  assert.equal(f.commands.length, 2);
  assert.equal(await f.options.attached(), undefined);
});

test("image replaced after busy cannot authorize another detach", async () => {
  const f = harness();
  f.failures = 1;
  f.options.wait = async () => {
    const current = await f.options.attached();
    current["image-path"] = "/other/image.sparseimage";
  };
  await assert.rejects(fixtures.detachOwnedDiskImage(f.options), {
    code: "ERR_ASSERTION",
  });
  assert.equal(f.commands.length, 1);
});

test("a successful command is insufficient while image remains attached", async () => {
  const f = harness();
  f.options.command = async () => {};
  await assert.rejects(fixtures.detachOwnedDiskImage(f.options), {
    code: "ERR_ASSERTION",
  });
  assert.ok(await f.options.attached());
  assert.deepEqual(f.waits, []);
});

test("a whole disk still busy seconds after its volume unmounted can finish detaching", async () => {
  // Observed on macOS runners: after the first busy attempt the APFS volume is gone,
  // but the image disk stays busy for more than four seconds before it detaches.
  const f = harness();
  f.failures = 5;
  f.options.wait = async (delay) => {
    f.waits.push(delay);
    const current = await f.options.attached();
    delete current["system-entities"][2]["mount-point"];
  };
  await fixtures.detachOwnedDiskImage(f.options);
  assert.equal(f.commands.length, 6);
  assert.deepEqual(f.waits, [250, 500, 1000, 2000, 4000]);
  assert.equal(await f.options.attached(), undefined);
});
