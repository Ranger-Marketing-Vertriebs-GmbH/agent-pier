import test from "node:test";
import assert from "node:assert/strict";
import * as fixtures from "../helpers/file-platform.js";

function harness() {
  const calls = [],
    waits = [];
  const busy = Object.assign(new Error("mount still busy"), { code: "EBUSY" });
  let failures = 1;
  return {
    calls,
    waits,
    busy,
    set failures(value) {
      failures = value;
    },
    options: {
      root: "/owned",
      directory: "/owned/mount",
      attached: async () => undefined,
      stat: async () => ({ dev: 1 }),
      remove: async (directory) => {
        calls.push(directory);
        if (failures-- > 0) throw busy;
      },
      wait: async (ms) => waits.push(ms),
    },
  };
}

test("detached mount must be removable before recursive fixture cleanup", async () => {
  const f = harness();
  await fixtures.removeDetachedMountDirectory(f.options);
  assert.deepEqual(f.calls, ["/owned/mount", "/owned/mount"]);
  assert.equal(f.waits.length, 1);
});

test("mount becoming attached during release is retained", async () => {
  const f = harness();
  let attached = false;
  f.options.attached = async () =>
    attached ? { "image-path": "/owned/image" } : undefined;
  f.options.wait = async () => {
    attached = true;
  };
  await assert.rejects(fixtures.removeDetachedMountDirectory(f.options), {
    code: "ERR_ASSERTION",
  });
  assert.equal(f.calls.length, 1);
});

test("foreign mount is never removed", async () => {
  const f = harness();
  f.options.stat = async (directory) => ({ dev: directory === "/owned" ? 1 : 2 });
  await assert.rejects(fixtures.removeDetachedMountDirectory(f.options), {
    code: "ERR_ASSERTION",
  });
  assert.equal(f.calls.length, 0);
});

for (const code of ["EACCES", "ENOTEMPTY"]) {
  test(`${code} retains fixture without retry`, async () => {
    const f = harness();
    f.busy.code = code;
    await assert.rejects(fixtures.removeDetachedMountDirectory(f.options), { code });
    assert.equal(f.calls.length, 1);
    assert.equal(f.waits.length, 0);
  });
}

test("persistently busy mount is retained after bounded release wait", async () => {
  const f = harness();
  f.failures = Infinity;
  await assert.rejects(fixtures.removeDetachedMountDirectory(f.options), {
    code: "EBUSY",
  });
  assert.equal(f.calls.length, 5);
  assert.equal(f.waits.length, 4);
});

test("a removed mount directory permits cleanup to resume", async () => {
  const f = harness();
  f.options.stat = async (directory) => {
    if (directory === "/owned/mount")
      throw Object.assign(new Error("already removed"), { code: "ENOENT" });
    return { dev: 1 };
  };
  await fixtures.removeDetachedMountDirectory(f.options);
  assert.deepEqual(f.calls, []);
});
