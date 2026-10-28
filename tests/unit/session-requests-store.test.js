import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionRequestsStore,
  requestsBlockChat,
} from "../../web/features/requests/session-requests-store.js";
import { apiCopy } from "../../web/lib/i18n/messages/components.js";

// A fake follow: records each followed session and lets the test report by hand,
// like startLiveTopic reports pushed frames and REST answers.
function store() {
  const follows = [];
  let clock = 1000;
  const requests = createSessionRequestsStore({
    follow: (sessionId, report) => {
      const follow = { sessionId, report, stops: 0, refreshes: 0, sets: [] };
      follow.reader = {
        refresh: () => (follow.refreshes += 1),
        set: (data) => {
          follow.sets.push(data);
          report({ data, error: "", loading: false });
        },
        stop: () => (follow.stops += 1),
      };
      follows.push(follow);
      return follow.reader;
    },
    now: () => clock,
  });
  return { follows, requests, tick: (ms) => (clock += ms) };
}

test("two subscribers of one session share one topic", () => {
  const { follows, requests } = store();
  const seen = { a: [], b: [] };
  requests.subscribe("s1", (snapshot) => seen.a.push(snapshot));
  requests.subscribe("s1", (snapshot) => seen.b.push(snapshot));
  assert.equal(follows.length, 1);
  assert.equal(follows[0].sessionId, "s1");
  assert.deepEqual(requests.get("s1"), { data: null, error: "", loading: true });
  follows[0].report({ data: { requests: [{ id: "r" }] }, error: "", loading: false });
  assert.equal(seen.a.length, 1);
  assert.equal(seen.a[0], seen.b[0]);
  assert.equal(seen.a[0], requests.get("s1"));
  assert.deepEqual(seen.a[0], {
    data: { requests: [{ id: "r", receivedAt: 1000 }] },
    error: "",
    loading: false,
  });
});

test("every new list is stamped with the time it arrived", () => {
  const { follows, requests, tick } = store();
  requests.subscribe("s1", () => {});
  const list = { requests: [{ id: "r", interaction: { client: "x", age: 0 } }] };
  follows[0].report({ data: list, error: "", loading: false });
  tick(500);
  // A report that only changes the connection keeps the stamp.
  follows[0].report({ data: list, error: "", loading: false, connected: true });
  assert.equal(requests.get("s1").data.requests[0].receivedAt, 1000);
  follows[0].report({ data: { ...list }, error: "", loading: false });
  assert.equal(requests.get("s1").data.requests[0].receivedAt, 1500);
});

test("the last unsubscribe stops following", () => {
  const { follows, requests } = store();
  const first = requests.subscribe("s1", () => {});
  const second = requests.subscribe("s1", () => {});
  first();
  assert.equal(follows[0].stops, 0);
  second();
  second();
  assert.equal(follows[0].stops, 1);
  requests.subscribe("s1", () => {});
  assert.equal(follows.length, 2);
});

test("a report of a stopped follow changes nothing", () => {
  const { follows, requests } = store();
  const stop = requests.subscribe("s1", () => {});
  stop();
  requests.subscribe("s1", () => {});
  follows[0].report({ data: { requests: [{ id: "old" }] }, error: "", loading: false });
  assert.equal(requests.get("s1").loading, true);
});

test("an error keeps the last data and a later list clears it", () => {
  const { follows, requests } = store();
  requests.subscribe("s1", () => {});
  const list = { requests: [] };
  follows[0].report({ data: list, error: "", loading: false });
  follows[0].report({ data: list, error: apiCopy.timedOut, loading: false });
  assert.deepEqual(requests.get("s1"), {
    data: { requests: [] },
    error: apiCopy.timedOut,
    loading: false,
  });
  follows[0].report({ data: { requests: [] }, error: "", loading: false });
  assert.equal(requests.get("s1").error, "");
});

test("update and refresh go to the session's topic", () => {
  const { follows, requests } = store();
  requests.update("s1", { requests: [{ id: "late" }] });
  requests.refresh("s1");
  assert.equal(follows.length, 0);
  assert.deepEqual(requests.get("s1"), { data: null, error: "", loading: true });
  requests.subscribe("s1", () => {});
  requests.update("s1", { requests: [{ id: "answered" }] });
  requests.refresh("s1");
  assert.deepEqual(follows[0].sets, [{ requests: [{ id: "answered" }] }]);
  assert.equal(follows[0].refreshes, 1);
  assert.equal(requests.get("s1").data.requests[0].id, "answered");
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

test("each request carries its list's server time", () => {
  const { follows, requests } = store();
  requests.subscribe("s1", () => {});
  follows[0].report({
    data: { sampledAt: 42, requests: [{ id: "r" }] },
    error: "",
    loading: false,
  });
  assert.deepEqual(requests.get("s1").data.requests, [
    { id: "r", sampledAt: 42, receivedAt: 1000 },
  ]);
});
