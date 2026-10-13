import test from "node:test";
import assert from "node:assert/strict";
import {
  createNavigationCoordinator,
  navigationReason,
  needsDecision,
} from "../../web/lib/navigation-guard.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
// Lets a queued request reach its guard before the next one arrives.
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("navigation commits only after the registered guard accepts", async () => {
  const coordinator = createNavigationCoordinator();
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
  const coordinator = createNavigationCoordinator();
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
  const coordinator = createNavigationCoordinator();
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
  await tick();
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

test("a queued request replaced before its turn asks no guard", async () => {
  const coordinator = createNavigationCoordinator();
  const first = deferred();
  const seen = [];
  coordinator.register(async ({ next }) => {
    seen.push(next.view);
    if (next.view === "settings") await first.promise;
    return true;
  });
  const commits = [];
  const request = (view) =>
    coordinator.request({
      next: { view },
      reason: "application",
      commit: () => commits.push(view),
    });
  const asking = request("settings");
  await tick();
  const queued = request("files");
  const newest = request("agents");
  first.resolve();
  assert.equal(await asking, false);
  assert.equal(await queued, false);
  assert.equal(await newest, true);
  assert.deepEqual(seen, ["settings", "agents"]);
  assert.deepEqual(commits, ["agents"]);
});

test("unregistering one guard does not remove its replacement", async () => {
  const coordinator = createNavigationCoordinator();
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

test("every registered guard is asked in order and the first refusal cancels", async () => {
  const coordinator = createNavigationCoordinator();
  const asked = [];
  coordinator.register(async () => {
    asked.push("files");
    return true;
  });
  const unregisterSettings = coordinator.register(() => {
    asked.push("settings");
    return false;
  });
  let commits = 0;
  const request = { reason: "application", commit: () => commits++ };
  assert.equal(await coordinator.request(request), false);
  assert.deepEqual(asked, ["files", "settings"]);
  assert.equal(commits, 0);
  unregisterSettings();
  assert.equal(await coordinator.request(request), true);
  assert.equal(commits, 1);
});

test("the unload warning stays while any protector holds it", () => {
  const target = new EventTarget();
  const coordinator = createNavigationCoordinator({ target });
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(unload(), false);
  const releaseEditor = coordinator.holdUnload();
  const releaseDraft = coordinator.holdUnload();
  assert.equal(unload(), true);
  releaseEditor();
  releaseEditor();
  assert.equal(coordinator.unloadHeld(), true);
  assert.equal(unload(), true);
  releaseDraft();
  assert.equal(coordinator.unloadHeld(), false);
  assert.equal(unload(), false);
});

test("settings drafts ignore passive navigation and their own destinations", () => {
  const stays = (request) => request.next?.tab === "profile";
  const app = { reason: "application", next: { tab: "work" } };
  assert.equal(needsDecision(app, { dirty: true, stays }), true);
  assert.equal(needsDecision(app, { dirty: false, stays }), false);
  assert.equal(
    needsDecision({ ...app, reason: "normalization" }, { dirty: true }),
    false,
  );
  assert.equal(needsDecision({ reason: "tab-close" }, { dirty: true }), false);
  assert.equal(
    needsDecision(
      { reason: "application", next: { tab: "profile" } },
      { dirty: true, stays },
    ),
    false,
  );
});

test("only real address normalisation is passive; other replaces stay user navigation", () => {
  assert.equal(navigationReason({ normalization: true }), "normalization");
  assert.equal(navigationReason({}), "application");
  assert.equal(navigationReason(), "application");
  assert.equal(
    needsDecision({ reason: navigationReason(), next: {} }, { dirty: true }),
    true,
  );
});
