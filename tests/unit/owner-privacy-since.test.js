import test from "node:test";
import assert from "node:assert/strict";
import { fromSince } from "../../server/features/users/owner-privacy.js";

const since = "2026-10-01T10:00:00.000Z";
const at = (minutes) => Date.parse(since) + minutes * 60000;
const said = (id, minutes, extra = {}) => ({
  id,
  role: "user",
  text: id,
  timestamp: at(minutes),
  ...extra,
});

test("a page wholly after since keeps its cursor to older pages", () => {
  const page = {
    messages: [said("a", 5), said("b", 6)],
    requests: [],
    nextBefore: "100",
  };
  assert.equal(fromSince(page, since).nextBefore, "100");
});

test("a page reaching back past since ends the paging", () => {
  const page = {
    messages: [said("old", -5), said("new", 5)],
    requests: [],
    nextBefore: "100",
  };
  const shown = fromSince(page, since);
  assert.equal(shown.nextBefore, null);
  assert.deepEqual(
    shown.messages.map((m) => m.id),
    ["new"],
  );
});

test("an empty page or a page without opt-in keeps its own cursor", () => {
  assert.equal(fromSince({ messages: [], nextBefore: "5" }, since).nextBefore, null);
  assert.equal(fromSince({ messages: [], nextBefore: "5" }, null).nextBefore, "5");
});

test("the reply to a request from before since stays hers, even when it ends later", () => {
  const request = (id, minutes) => ({
    id,
    createdAt: new Date(at(minutes)).toISOString(),
    attempt: { id: `${id}-attempt`, runtimeRunId: `${id}-run` },
  });
  const shown = fromSince(
    {
      messages: [
        said("early-reply", 1, { role: "assistant", runId: "early-run" }),
        said("late", 2, { requestId: "late" }),
        said("late-reply", 3, { role: "assistant", runId: "late-attempt" }),
      ],
      requests: [request("early", -1), request("late", 2)],
    },
    since,
  );
  assert.deepEqual(
    shown.messages.map((m) => m.id),
    ["late", "late-reply"],
  );
  assert.deepEqual(
    shown.requests.map((r) => r.id),
    ["late"],
  );
});
