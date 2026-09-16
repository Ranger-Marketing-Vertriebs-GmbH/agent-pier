import test from "node:test";
import assert from "node:assert/strict";
import { createSessionLifecycle } from "../../server/application/session-lifecycle.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("account usage remains active when launch finishes during an old session-list read", async () => {
  const listed = deferred(),
    finishLaunch = deferred();
  const sessions = [];
  const lifecycle = createSessionLifecycle({
    sessions: {
      list: async () => {
        const snapshot = structuredClone(sessions);
        await listed.promise;
        return snapshot;
      },
    },
  });
  const launch = lifecycle.withAccountUsage("target", () => finishLaunch.promise);
  const checking = lifecycle.activeFor("target");
  sessions.push({ id: "new", accountId: "target", status: "running" });
  finishLaunch.resolve();
  await launch;
  listed.resolve();
  assert.equal(await checking, true);
});

test("account usage acquired during a session-list read is checked before reporting idle", async () => {
  const listed = deferred(),
    finishLaunch = deferred();
  const lifecycle = createSessionLifecycle({
    sessions: {
      list: async () => {
        await listed.promise;
        return [];
      },
    },
  });
  const checking = lifecycle.activeFor("target");
  const launch = lifecycle.withAccountUsage("target", () => finishLaunch.promise);
  try {
    listed.resolve();
    assert.equal(await checking, true);
    assert.equal(await lifecycle.activeFor("other"), false);
  } finally {
    finishLaunch.resolve();
    await launch;
  }
  assert.equal(await lifecycle.activeFor("target"), false);
});
