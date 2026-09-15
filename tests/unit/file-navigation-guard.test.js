import test from "node:test";
import assert from "node:assert/strict";
import { createFileNavigationCoordinator } from "../../web/features/files/file-navigation-guard.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("navigation commits only after the registered guard accepts", async () => {
  const coordinator = createFileNavigationCoordinator();
  const decision = deferred();
  const commits = [];
  coordinator.register((request) => {
    assert.equal(request.reason, "application");
    return decision.promise;
  });

  const navigation = coordinator.request({
    next: { view: "settings" },
    reason: "application",
    commit: () => commits.push("settings"),
  });
  assert.deepEqual(commits, []);
  decision.resolve(true);
  assert.equal(await navigation, true);
  assert.deepEqual(commits, ["settings"]);
});

test("a cancelled guard does not commit", async () => {
  const coordinator = createFileNavigationCoordinator();
  coordinator.register(async () => false);
  let committed = false;
  assert.equal(
    await coordinator.request({
      next: { view: "files" },
      reason: "application",
      commit: () => {
        committed = true;
      },
    }),
    false,
  );
  assert.equal(committed, false);
});

test("a newer request invalidates an older pending decision and is serialized", async () => {
  const coordinator = createFileNavigationCoordinator();
  const first = deferred();
  const seen = [];
  coordinator.register(async ({ next }) => {
    seen.push(next.view);
    if (next.view === "settings") await first.promise;
    return true;
  });
  const commits = [];
  const older = coordinator.request({
    next: { view: "settings" },
    reason: "application",
    commit: () => commits.push("settings"),
  });
  const newer = coordinator.request({
    next: { view: "files" },
    reason: "application",
    commit: () => commits.push("files"),
  });
  first.resolve();
  assert.equal(await older, false);
  assert.equal(await newer, true);
  assert.deepEqual(seen, ["settings", "files"]);
  assert.deepEqual(commits, ["files"]);
});

test("unregistering one guard does not remove its replacement", async () => {
  const coordinator = createFileNavigationCoordinator();
  const unregisterOld = coordinator.register(async () => false);
  coordinator.register(async () => true);
  unregisterOld();
  let commits = 0;
  assert.equal(
    await coordinator.request({
      reason: "tab-close",
      commit: () => commits++,
    }),
    true,
  );
  assert.equal(commits, 1);
});
