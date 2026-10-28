import test from "node:test";
import assert from "node:assert/strict";
import { startLiveTopic } from "../../web/lib/live/live-topic-reader.js";
import { releaseHeld, shownState } from "../../web/lib/live/useLiveTopic.js";
import { fakeEnv } from "../helpers/fake-browser.js";

// useLiveTopic's own state (`{key, ...state}`, as its report sets it) across a topic
// followed, let go and followed again: the second follow never shows the first one's
// value. The reader runs against a fake LiveClient; React's setState is a plain
// updater applied here.
function fakeClient() {
  const listeners = new Set();
  return {
    subscribe(_topicId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => ({ connected: true, fallback: false }),
    emit: (event) => [...listeners].forEach((listener) => listener(event)),
  };
}

test("a topic followed again starts from loading, not the previous value", () => {
  const client = fakeClient();
  const env = fakeEnv().env;
  const topicId = "job.plugins:a";
  const key = JSON.stringify([topicId, ""]);
  let current = null;
  const setCurrent = (next) =>
    (current = typeof next === "function" ? next(current) : next);
  const follow = () =>
    startLiveTopic({
      topicId,
      client,
      env,
      read: async () => ({}),
      report: (state) => setCurrent({ key, ...state }),
    });
  // First follow: the change's end is pushed and shown.
  const first = follow();
  client.emit({ type: "data", data: { busy: false } });
  assert.deepEqual(shownState(current, key, topicId).data, { busy: false });
  // Let go (the topic id goes to null): the hook's cleanup.
  first.stop();
  setCurrent(releaseHeld(key));
  assert.deepEqual(shownState(current, "", null), {
    data: null,
    error: "",
    loading: false,
    connected: false,
  });
  // Followed again: the first render, before the effect subscribes, shows loading,
  // never the old end (a caller's effect would act on it at once).
  assert.deepEqual(shownState(current, key, topicId), {
    data: null,
    error: "",
    loading: true,
    connected: false,
  });
  const second = follow();
  assert.equal(shownState(current, key, topicId).data, null);
  client.emit({ type: "data", data: { busy: true } });
  assert.deepEqual(shownState(current, key, topicId).data, { busy: true });
  second.stop();
});

test("ending one topic leaves another topic's value alone", () => {
  const other = { key: JSON.stringify(["inbox", ""]), data: { n: 1 } };
  assert.equal(releaseHeld(JSON.stringify(["job.plugins:a", ""]))(other), other);
  assert.equal(releaseHeld(other.key)(other), null);
  assert.deepEqual(shownState(other, other.key, "inbox").data, { n: 1 });
  assert.equal(shownState(other, "x", "job.plugins:a").loading, true);
});
