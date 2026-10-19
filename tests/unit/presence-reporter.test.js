import test from "node:test";
import assert from "node:assert/strict";
import {
  heartbeatMs,
  startPresenceReporter,
} from "../../web/features/notifications/presence-reporter.js";

function page({ visible = true, focus = true } = {}) {
  const listeners = { doc: new Map(), win: new Map() };
  const target = (map) => ({
    addEventListener: (name, handler) => map.set(name, handler),
    removeEventListener: (name) => map.delete(name),
  });
  const state = { visible, focus, now: 0, tick: null, sent: [] };
  const doc = {
    ...target(listeners.doc),
    get visibilityState() {
      return state.visible ? "visible" : "hidden";
    },
    hasFocus: () => state.focus,
  };
  const win = { ...target(listeners.win), location: { pathname: "/inbox" } };
  const stop = startPresenceReporter({
    doc,
    win,
    send: (route) => state.sent.push(route),
    now: () => state.now,
    setTimer: (fn) => (state.tick = fn),
    clearTimer: () => (state.tick = null),
  });
  return { state, win, listeners, stop };
}

test("a visible but unfocused window never reports its view", () => {
  const { state, listeners } = page({ focus: false });
  state.now += heartbeatMs;
  state.tick();
  listeners.doc.get("visibilitychange")();
  assert.deepEqual(state.sent, []);
  // Focusing the window reports at once.
  state.focus = true;
  listeners.win.get("focus")();
  assert.deepEqual(state.sent, ["/inbox"]);
});

test("a focused window reports, and stops on blur or when hidden", () => {
  const { state, win, listeners, stop } = page();
  assert.deepEqual(state.sent, ["/inbox"]);
  state.now += 1000;
  state.tick();
  assert.equal(state.sent.length, 1, "an unchanged view waits for the heartbeat");
  win.location.pathname = "/sessions/s1/chat";
  state.tick();
  assert.deepEqual(state.sent, ["/inbox", "/sessions/s1/chat"]);
  listeners.win.get("blur")();
  state.now += heartbeatMs;
  state.tick();
  assert.equal(state.sent.length, 2, "a blurred window stops reporting");
  state.focus = true;
  listeners.win.get("focus")();
  assert.equal(state.sent.length, 3);
  state.visible = false;
  state.now += heartbeatMs;
  state.tick();
  assert.equal(state.sent.length, 3, "a hidden page stops reporting");
  stop();
  assert.equal(state.tick, null);
  assert.equal(listeners.win.size + listeners.doc.size, 0);
});
