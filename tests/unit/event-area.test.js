import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { eventAreaView, eventRowView } from "../../web/features/assistants/event-area.js";

const routine = (at, extra = {}) => ({
  id: `routine:${at}`,
  source: "routine",
  name: "AI News Update",
  at,
  status: "done",
  firstLine: "AI news, October 14",
  ...extra,
});
const hook = (at, extra = {}) => ({
  id: `hook:${at}`,
  source: "hook",
  name: "Zabbix",
  sender: "Zabbix server",
  at,
  status: "done",
  firstLine: "Disk on nas is 95% full",
  hookId: "h1",
  eventId: `e${at}`,
  ...extra,
});

test("unread counts events newer than seenAt", () => {
  setLanguage("en");
  const events = [hook(300), routine(200), routine(100)];
  const view = eventAreaView(events, 150);
  assert.equal(view.count, 3);
  assert.equal(view.unread, 2);
  assert.equal(view.summary, "3 events · 2 new");
  // Never opened: everything is new; opened after the newest: nothing is.
  assert.equal(eventAreaView(events, undefined).unread, 3);
  const seen = eventAreaView(events, 300);
  assert.equal(seen.unread, 0);
  assert.equal(seen.summary, "3 events");
});

test("the area shows a running event and only unseen failures", () => {
  setLanguage("en");
  const events = [
    hook(300, { status: "running", firstLine: "" }),
    routine(200, { status: "failed", firstLine: "" }),
    routine(100, { status: "failed", firstLine: "" }),
  ];
  const view = eventAreaView(events, 150);
  assert.equal(view.running, true);
  assert.equal(view.failed, 1);
  assert.equal(eventAreaView(events, 300).failed, 0);
  assert.equal(eventAreaView([routine(1)], 0).running, false);
});

test("a throttled event gets the neutral tone and Throttled", () => {
  setLanguage("en");
  const row = eventRowView(hook(1, { status: "throttled", firstLine: "" }));
  assert.equal(row.status, "Throttled");
  assert.equal(row.tone, "neutral");
  assert.equal(row.icon, "link");
  assert.equal(row.label, "Zabbix · Zabbix server");
  setLanguage("de");
  assert.equal(eventRowView(hook(1, { status: "throttled" })).status, "Gedrosselt");
  setLanguage("en");
});

test("duplicates appear in the detail", () => {
  setLanguage("en");
  assert.equal(
    eventRowView(hook(1, { duplicates: 3 })).detail,
    "Disk on nas is 95% full · 3 duplicates",
  );
  assert.equal(
    eventRowView(hook(1, { duplicates: 1, firstLine: "" })).detail,
    "1 duplicate",
  );
  assert.equal(eventRowView(hook(1)).detail, "Disk on nas is 95% full");
});

test("each status maps to its chip and tone", () => {
  setLanguage("en");
  const chips = ["running", "done", "failed", "silent"].map((status) => {
    const { status: label, tone } = eventRowView(routine(1, { status }));
    return [label, tone];
  });
  assert.deepEqual(chips, [
    ["Running", "running"],
    ["Done", "ok"],
    ["Failed", "error"],
    ["Silent", "neutral"],
  ]);
});

test("a failed routine row names a known note and a check-in its kind", () => {
  setLanguage("en");
  const failed = eventRowView(
    routine(1, { status: "failed", firstLine: "", notes: ["ssh_refused"] }),
  );
  assert.equal(failed.detail, "SSH refused: host not trusted for routines");
  // Unknown machine codes never show.
  assert.equal(
    eventRowView(routine(1, { status: "failed", firstLine: "", notes: ["x_y"] })).detail,
    "",
  );
  const checkin = eventRowView({ ...routine(1), source: "checkin", name: "" });
  assert.equal(checkin.label, "Check-in");
  assert.equal(checkin.icon, "refresh");
  assert.equal(eventRowView(routine(1)).label, "AI News Update");
  assert.equal(
    eventRowView(hook(1, { test: true })).detail.startsWith("Test event"),
    true,
  );
});
