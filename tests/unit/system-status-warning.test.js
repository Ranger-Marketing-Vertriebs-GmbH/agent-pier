import test from "node:test";
import assert from "node:assert/strict";
import {
  DiskWarning,
  freePercent,
  nextDiskWarning,
} from "../../server/features/system-status/disk-warning.js";
import { pushPayload } from "../../server/features/notifications/push-validation.js";

const disk = (percent) => ({ totalBytes: 1000, freeBytes: percent * 10 });

// The persistence and notify surface of NotificationService.
function fakeNotifications(stored = {}) {
  const notices = [];
  return {
    notices,
    stored,
    observation: (id) => stored[id],
    observe: (id, value) => {
      stored[id] = value;
    },
    notify: async (input) => {
      notices.push(pushPayload(input));
    },
  };
}

test("the low disk warning starts below 10 % and clears only at 12 %", () => {
  assert.equal(nextDiskWarning(false, 10), false);
  assert.equal(nextDiskWarning(false, 9.9), true);
  assert.equal(nextDiskWarning(true, 11.9), true);
  assert.equal(nextDiskWarning(true, 12), false);
  assert.equal(nextDiskWarning(true, null), true);
  assert.equal(nextDiskWarning(false, NaN), false);
  assert.equal(freePercent({ totalBytes: 0, freeBytes: 0 }), null);
  assert.equal(freePercent(disk(9.94)), 9.9);
});

test("one push notice per low disk episode, none while it hovers at the threshold", async () => {
  let now = Date.parse("2026-10-18T08:00:00Z");
  const notifications = fakeNotifications();
  const warning = new DiskWarning({ notifications, now: () => now });
  for (const percent of [20, 9, 8, 10.5, 9.5, 11])
    assert.equal(warning.update(disk(percent)), percent < 20);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.notices.length, 1);
  assert.deepEqual(Object.keys(notifications.notices[0]).sort(), ["eventId", "kind"]);
  assert.equal(notifications.notices[0].kind, "disk-space");
  assert.equal(warning.update(disk(15)), false);
  now += 60_000;
  assert.equal(warning.update(disk(5)), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.notices.length, 2);
  assert.notEqual(notifications.notices[0].eventId, notifications.notices[1].eventId);
});

test("a restart during a low disk episode does not notify again", async () => {
  const notifications = fakeNotifications();
  new DiskWarning({ notifications }).update(disk(5));
  const restarted = new DiskWarning({ notifications });
  assert.equal(restarted.active, true);
  assert.equal(restarted.update(disk(6)), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.notices.length, 1);
});

test("a failed push or store keeps the warning state", async () => {
  const errors = [];
  const warning = new DiskWarning({
    notifications: {
      observation: () => "not json",
      observe: () => {
        throw Error("readonly");
      },
      notify: async () => {
        throw Error("offline");
      },
    },
    onError: (error) => errors.push(error.message),
  });
  assert.equal(warning.update(disk(1)), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors.sort(), ["offline", "readonly"]);
});
