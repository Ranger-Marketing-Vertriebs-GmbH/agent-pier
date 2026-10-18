import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
import { appDocumentPath } from "../../server/http/security.js";
import {
  inboxSummary,
  publishInboxSummary,
} from "../../web/features/inbox/inbox-store.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));

test("every inbox item has a stable address that reads back the same", () => {
  assert.deepEqual(read("/inbox"), {
    view: "inbox",
    inboxTab: "all",
    itemType: "",
    itemId: "",
  });
  const item = read("/inbox/gate/run-1?tab=gates");
  assert.deepEqual(item, {
    view: "inbox",
    inboxTab: "gates",
    itemType: "gate",
    itemId: "run-1",
  });
  assert.equal(routePath(item), "/inbox/gate/run-1?tab=gates");
  assert.equal(routePath({ view: "inbox" }), "/inbox");
  assert.equal(read("/inbox?tab=nonsense").inboxTab, "all");
  assert.equal(read("/inbox/session/abc").view, "missing");
  assert.equal(read("/inbox/gate/bad id").view, "missing");
  for (const path of ["/inbox", "/inbox/question/abc", "/inbox/team/t-1"])
    assert.equal(appDocumentPath.test(path), true, path);
  assert.equal(appDocumentPath.test("/inbox/other/abc"), false);
});

test("the shared count keeps the newest revision of a server process", () => {
  const counts = (all) => ({ all, questions: all, approvals: 0, gates: 0, agents: 0 });
  publishInboxSummary({ instance: "a", revision: 5, counts: counts(3) });
  publishInboxSummary({ instance: "a", revision: 4, counts: counts(9) });
  assert.equal(inboxSummary().counts.all, 3);
  publishInboxSummary({ instance: "a", revision: 6, counts: counts(2) });
  assert.equal(inboxSummary().counts.all, 2);
  // A restarted server counts from one again.
  publishInboxSummary({ instance: "b", revision: 1, counts: counts(1) });
  assert.equal(inboxSummary().counts.all, 1);
  publishInboxSummary(null);
  publishInboxSummary({ instance: "b" });
  assert.equal(inboxSummary().revision, 1);
});
