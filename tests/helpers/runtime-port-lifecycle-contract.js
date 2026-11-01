import test from "node:test";
import assert from "node:assert/strict";

// The install, update, rollback and restart-reason methods of the host sub-port
// (agent-runtime.js), part of runtimePortContract. They need no installed runtime:
// installing, migrating and staging are pinned by each adapter's own tests.
export function lifecycleContract(name, make) {
  test(`${name}: host names install, update, rollback and restart-reason methods`, async () => {
    const { host } = await make({});
    for (const method of [
      "install",
      "sameInstall",
      "target",
      "current",
      "stageUpdate",
      "migrate",
      "stopMigration",
      "clearMigration",
      "assertStopped",
      "restartNeeded",
      "generation",
    ])
      assert.equal(typeof host[method], "function", method);
  });

  test(`${name}: host.target() names the shipped version; no empty record is it`, async () => {
    const { host } = await make({});
    const target = host.target();
    assert.equal(typeof target.version, "string");
    assert.ok(target.version.length > 0);
    assert.equal(typeof target.nodeVersion, "string");
    // No install record, or one without an identity, is never the shipped version.
    assert.equal(host.current(null), false);
    assert.equal(host.current({}), false);
    assert.equal(host.sameInstall(null, null), false);
    assert.equal(host.sameInstall(target, null), false);
  });

  test(`${name}: host.restartNeeded() and generation() follow the host's starts`, async () => {
    const { host } = await make({});
    assert.equal(host.restartNeeded(), true);
    const first = host.generation();
    assert.notEqual(first, null);
    await host.stop();
    // A stopped host loads every saved change at its next start.
    assert.equal(host.restartNeeded(), false);
    await host.assertStopped();
    await host.start();
    assert.equal(host.restartNeeded(), true);
    const second = host.generation();
    assert.notEqual(second, null);
    assert.notEqual(second, first);
    await host.restart();
    assert.notEqual(host.generation(), second);
  });

  test(`${name}: host.stopMigration() without a recorded migration resolves`, async () => {
    const { host } = await make({});
    await host.stopMigration(null);
    await host.stopMigration({});
  });
}

/**
 * The in-memory install, update, rollback and restart-reason methods of fakeRuntime:
 * installs nothing, ships `target` and counts a generation per start (`generation()`
 * reads it). `running()` tells whether the fake host runs.
 */
export function fakeLifecyclePorts({ running, generation }) {
  const target = Object.freeze({ version: "fake-1", nodeVersion: "fake-node" });
  const identity = (record) => record?.version && record?.nodeVersion;
  return {
    install: async () => ({ ...target }),
    sameInstall: (a, b) =>
      !!identity(a) &&
      !!identity(b) &&
      a.version === b.version &&
      a.nodeVersion === b.nodeVersion,
    target: () => ({ ...target }),
    current: (record) =>
      !!identity(record) &&
      record.version === target.version &&
      record.nodeVersion === target.nodeVersion,
    stageUpdate: () => null,
    migrate: async () => {},
    stopMigration: async () => {},
    clearMigration: () => {},
    assertStopped: async () => {
      if (running())
        throw Object.assign(Error("running"), { code: "OWNERSHIP_CONFLICT" });
    },
    restartNeeded: () => running(),
    generation: () => (running() ? generation() : null),
  };
}
