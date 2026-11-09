import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAppBadge,
  watchAppBadge,
} from "../../web/features/notifications/app-badge.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function target() {
  const listeners = new Map();
  return {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
    fire: (name) => listeners.get(name)?.(),
    listeners,
  };
}
function badgeNavigator() {
  const nav = { badge: undefined };
  nav.setAppBadge = async (count) => (nav.badge = count);
  nav.clearAppBadge = async () => (nav.badge = 0);
  return nav;
}

test("the badge shows the count and clears at zero; without support nothing happens", async () => {
  const nav = badgeNavigator();
  applyAppBadge(nav, 3);
  await settle();
  assert.equal(nav.badge, 3);
  applyAppBadge(nav, 0);
  await settle();
  assert.equal(nav.badge, 0);
  applyAppBadge({}, 2);
  // A refused badge call is ignored.
  applyAppBadge({ setAppBadge: () => Promise.reject(new Error("no")) }, 1);
  await settle();
});

test("a badge a push set in the background is cleared when the app comes back", async () => {
  const nav = badgeNavigator();
  const doc = { ...target(), visibilityState: "hidden" };
  const win = target();
  const stop = watchAppBadge({ count: () => 0, nav, doc, win });
  // The service worker set the badge while the app was suspended.
  nav.badge = 1;
  doc.fire("visibilitychange");
  await settle();
  assert.equal(nav.badge, 1);
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  await settle();
  assert.equal(nav.badge, 0);
  // A page restored from the back-forward cache re-applies it too.
  nav.badge = 1;
  win.fire("pageshow");
  await settle();
  assert.equal(nav.badge, 0);
  stop();
  assert.equal(doc.listeners.size, 0);
  assert.equal(win.listeners.size, 0);
});
