import test from "node:test";
import assert from "node:assert/strict";
import { workspaceStateView } from "../../web/app/workspace-state-view.js";

const state = (readStartedAt, sessions = []) => ({ sessions, readStartedAt });
const live = (data, extra = {}) => ({ data, error: "", loading: false, ...extra });

test("a push from a read that started before the refresh keeps the refresh answer", () => {
  const before = state(100);
  // refresh() started from `before`, after the caller created a session.
  const answer = state(300, [{ id: "new" }]);
  const read = { basis: before, data: answer, error: "" };
  assert.equal(workspaceStateView(live(before), read).data, answer);
  // That older read finishes and pushes after the refresh answered.
  const older = state(200);
  assert.equal(workspaceStateView(live(older), read).data, answer);
  // A read started after the refresh replaces it.
  const later = state(400, [{ id: "new" }, { id: "other" }]);
  assert.equal(workspaceStateView(live(later), read).data, later);
});

test("without read stamps a push after the refresh began wins", () => {
  const before = { sessions: [] };
  const answer = { sessions: [{ id: "new" }] };
  const read = { basis: before, data: answer, error: "" };
  assert.equal(workspaceStateView(live(before), read).data, answer);
  const pushed = { sessions: [{ id: "new" }, { id: "more" }] };
  assert.equal(workspaceStateView(live(pushed), read).data, pushed);
});

test("a failed refresh shows its error until the next pushed value", () => {
  const held = state(100);
  const read = { basis: held, data: null, error: "Server down" };
  assert.deepEqual(workspaceStateView(live(held), read), {
    data: held,
    failure: "Server down",
    loading: false,
  });
  // The next topic message clears it, even with the same state.
  const same = state(100);
  assert.equal(workspaceStateView(live(same), read).failure, "");
});

test("the next successful refresh clears a refresh error", () => {
  const held = state(100);
  const failed = { basis: held, data: null, error: "Server down" };
  assert.equal(workspaceStateView(live(held), failed).failure, "Server down");
  const answer = state(200);
  const succeeded = { basis: held, data: answer, error: "" };
  assert.deepEqual(workspaceStateView(live(held), succeeded), {
    data: answer,
    failure: "",
    loading: false,
  });
});

test("the topic's own error and loading show without a refresh", () => {
  assert.deepEqual(workspaceStateView(live(null, { loading: true }), null), {
    data: null,
    failure: "",
    loading: true,
  });
  assert.deepEqual(workspaceStateView(live(null, { error: "Timeout" }), null), {
    data: null,
    failure: "Timeout",
    loading: false,
  });
  // A refresh answer shows before the first push.
  const answer = state(50);
  assert.equal(
    workspaceStateView(live(null, { loading: true }), {
      basis: null,
      data: answer,
      error: "",
    }).data,
    answer,
  );
});
