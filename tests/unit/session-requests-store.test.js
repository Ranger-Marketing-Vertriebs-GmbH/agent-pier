import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionRequestsStore,
  requestsBlockChat,
} from "../../web/features/requests/session-requests-store.js";
import { apiCopy } from "../../web/lib/i18n/messages/components.js";
import { fakeEnv, settle } from "../helpers/fake-browser.js";

// A fake startPolling: records each loop and lets the test run its ticks by hand.
function fakePolling() {
  const loops = [];
  const startPolling = (run, interval) => {
    const loop = { run, interval, stops: 0 };
    loops.push(loop);
    return () => {
      loop.stops += 1;
    };
  };
  const tick = (loop) => loop.run(new AbortController().signal);
  return { loops, startPolling, tick };
}

function store(options = {}) {
  const polling = fakePolling();
  const reads = [];
  const requests = createSessionRequestsStore({
    read: async (sessionId) => {
      reads.push(sessionId);
      return { requests: [{ id: `${sessionId}-${reads.length}` }] };
    },
    startPolling: polling.startPolling,
    ...options,
  });
  return { polling, reads, requests };
}

test("two subscribers of one session share one loop", async () => {
  const { polling, reads, requests } = store();
  const seen = { a: [], b: [] };
  requests.subscribe("s1", (snapshot) => seen.a.push(snapshot));
  requests.subscribe("s1", (snapshot) => seen.b.push(snapshot));
  assert.equal(polling.loops.length, 1);
  assert.equal(polling.loops[0].interval, 1500);
  assert.deepEqual(requests.get("s1"), { data: null, error: "", loading: true });
  await polling.tick(polling.loops[0]);
  assert.deepEqual(reads, ["s1"]);
  assert.equal(seen.a.length, 1);
  assert.equal(seen.a[0], seen.b[0]);
  assert.equal(seen.a[0], requests.get("s1"));
  assert.deepEqual(seen.a[0], {
    data: { requests: [{ id: "s1-1" }] },
    error: "",
    loading: false,
  });
});

test("the last unsubscribe stops the loop", () => {
  const { polling, requests } = store();
  const first = requests.subscribe("s1", () => {});
  const second = requests.subscribe("s1", () => {});
  first();
  assert.equal(polling.loops[0].stops, 0);
  second();
  second();
  assert.equal(polling.loops[0].stops, 1);
  requests.subscribe("s1", () => {});
  assert.equal(polling.loops.length, 2);
});

test("sessions poll independently", async () => {
  const { polling, reads, requests } = store();
  const seen = [];
  const stopOne = requests.subscribe("s1", () => seen.push("s1"));
  requests.subscribe("s 2", () => seen.push("s2"));
  assert.equal(polling.loops.length, 2);
  await polling.tick(polling.loops[1]);
  assert.deepEqual(reads, ["s 2"]);
  assert.deepEqual(seen, ["s2"]);
  assert.equal(requests.get("s1").loading, true);
  stopOne();
  assert.equal(polling.loops[0].stops, 1);
  assert.equal(polling.loops[1].stops, 0);
});

test("an error keeps the last data and a later read clears it", async () => {
  let fail = false;
  const polling = fakePolling();
  const requests = createSessionRequestsStore({
    read: async () => {
      if (fail) throw new Error("Request failed (500)");
      return { requests: [] };
    },
    startPolling: polling.startPolling,
  });
  requests.subscribe("s1", () => {});
  await polling.tick(polling.loops[0]);
  fail = true;
  await polling.tick(polling.loops[0]);
  assert.deepEqual(requests.get("s1"), {
    data: { requests: [] },
    error: "Request failed (500)",
    loading: false,
  });
  fail = false;
  await polling.tick(polling.loops[0]);
  assert.equal(requests.get("s1").error, "");
});

test("a read past 5 s is aborted and keeps the data", async () => {
  const fake = fakeEnv();
  const polling = fakePolling();
  let hang = false;
  const signals = [];
  const requests = createSessionRequestsStore({
    read: (sessionId, signal) => {
      signals.push(signal);
      return hang
        ? new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          )
        : Promise.resolve({ requests: [] });
    },
    startPolling: polling.startPolling,
    env: fake.env,
  });
  requests.subscribe("s1", () => {});
  await polling.tick(polling.loops[0]);
  hang = true;
  const pending = polling.tick(polling.loops[0]);
  await fake.advance(4999);
  assert.equal(signals[1].aborted, false);
  await fake.advance(1);
  await pending;
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(requests.get("s1"), {
    data: { requests: [] },
    error: "",
    loading: false,
  });
});

test("update replaces the data at once and drops a read that started before", async () => {
  const polling = fakePolling();
  let resolve;
  const requests = createSessionRequestsStore({
    read: () => new Promise((done) => (resolve = done)),
    startPolling: polling.startPolling,
  });
  const seen = [];
  requests.subscribe("s1", (snapshot) => seen.push(snapshot));
  const pending = polling.tick(polling.loops[0]);
  requests.update("s1", { requests: [{ id: "answered" }] });
  resolve({ requests: [{ id: "stale" }] });
  await pending;
  await settle();
  assert.equal(seen.length, 1);
  assert.deepEqual(requests.get("s1").data, { requests: [{ id: "answered" }] });
});

test("refresh restarts the session's loop", () => {
  const { polling, requests } = store();
  requests.subscribe("s1", () => {});
  requests.refresh("s1");
  assert.equal(polling.loops[0].stops, 1);
  assert.equal(polling.loops.length, 2);
  requests.refresh("unknown");
  assert.equal(polling.loops.length, 2);
});

test("an old unsubscriber does not stop a loop created after it", () => {
  const { polling, requests } = store();
  const old = requests.subscribe("s1", () => {});
  old();
  const listener = () => {};
  requests.subscribe("s1", listener);
  old();
  assert.equal(polling.loops[1].stops, 0);
  assert.equal(requests.get("s1").loading, true);
});

test("update without listeners changes nothing", () => {
  const { polling, requests } = store();
  requests.update("s1", { requests: [{ id: "late" }] });
  assert.equal(polling.loops.length, 0);
  assert.deepEqual(requests.get("s1"), { data: null, error: "", loading: true });
});

test("timeouts over held data stay quiet until the third in a row", async () => {
  const fake = fakeEnv();
  const polling = fakePolling();
  let hang = false;
  const requests = createSessionRequestsStore({
    read: (sessionId, signal) =>
      hang
        ? new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          )
        : Promise.resolve({ requests: [] }),
    startPolling: polling.startPolling,
    env: fake.env,
  });
  const seen = [];
  requests.subscribe("s1", (snapshot) => seen.push(snapshot));
  const timeout = async () => {
    const pending = polling.tick(polling.loops[0]);
    await fake.advance(5000);
    await pending;
  };
  await polling.tick(polling.loops[0]);
  hang = true;
  await timeout();
  await timeout();
  assert.equal(seen.length, 1);
  assert.equal(requests.get("s1").error, "");
  await timeout();
  assert.equal(requests.get("s1").error, apiCopy.timedOut);
  assert.deepEqual(requests.get("s1").data, { requests: [] });
  hang = false;
  await polling.tick(polling.loops[0]);
  hang = true;
  await timeout();
  assert.equal(requests.get("s1").error, "");
});

test("a first read that times out is shown at once", async () => {
  const fake = fakeEnv();
  const polling = fakePolling();
  const requests = createSessionRequestsStore({
    read: (sessionId, signal) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
    startPolling: polling.startPolling,
    env: fake.env,
  });
  requests.subscribe("s1", () => {});
  const pending = polling.tick(polling.loops[0]);
  await fake.advance(5000);
  await pending;
  assert.deepEqual(requests.get("s1"), {
    data: null,
    error: apiCopy.timedOut,
    loading: false,
  });
});

test("only open requests or missing data block the chat", () => {
  const empty = { requests: [] };
  assert.equal(requestsBlockChat({ data: null, error: "", loading: true }), true);
  assert.equal(requestsBlockChat({ data: null, error: "boom", loading: false }), true);
  assert.equal(
    requestsBlockChat({ data: empty, error: apiCopy.timedOut, loading: false }),
    false,
  );
  assert.equal(requestsBlockChat({ data: empty, error: "boom", loading: false }), false);
  assert.equal(
    requestsBlockChat({ data: { requests: [{ id: "r" }] }, error: "", loading: false }),
    true,
  );
  assert.equal(requestsBlockChat({ data: null, error: "", loading: false }), false);
});
