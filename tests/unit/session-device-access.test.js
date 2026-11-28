import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage, withLanguage } from "../../web/lib/i18n/index.js";
import {
  accessBlocked,
  accessDraft,
  deviceEligibleSession,
  deviceGrantEntries,
  grantedIds,
  grantsAnything,
  launchSummary,
  manageRows,
  noAccess,
  prunedDraft,
  sameAccess,
  validAccess,
  withGranted,
  withManage,
} from "../../web/features/devices/session-device-access.js";

// The rules of a session's Android devices as the owner chooses them, in the
// new-session dialog and in a running session's dialog.
setLanguage("en");

const owner = { kind: "owner", id: "owner", name: "", gone: false };
const row = (patch = {}) => ({
  id: "d-0000000000a1",
  name: "Pixel",
  state: "stopped",
  creator: owner,
  assigned: false,
  manage: false,
  own: false,
  ...patch,
});
const access = (devices = [], patch = {}) => ({
  availability: { available: true, reason: null },
  eligible: true,
  tools: "ready",
  create: false,
  devices,
  ...patch,
});
const pixel = row({ assigned: true });
const tablet = row({ id: "d-0000000000b2", name: "Tablet" });
const mine = row({
  id: "d-0000000000c3",
  name: "Scratch",
  creator: { kind: "session", id: "s1", name: "Checkout", gone: false },
  manage: true,
  own: true,
});

test("only a complete access is shown", () => {
  assert.equal(validAccess(access()), true);
  for (const value of [
    null,
    {},
    { devices: [] },
    access([], { availability: null }),
    access([], { eligible: undefined }),
    access([], { create: "yes" }),
    { ...access(), devices: null },
  ])
    assert.equal(validAccess(value), false);
});

test("the session's menu offers devices to a running coding session only", () => {
  const session = { id: "s1", tool: "claude", status: "running" };
  assert.equal(deviceEligibleSession(session), true);
  assert.equal(deviceEligibleSession({ ...session, tool: "codex" }), true);
  for (const other of [
    null,
    { ...session, status: "stopped" },
    { ...session, tool: "shell" },
    { ...session, purpose: "login" },
    { ...session, pipeline: { runId: "r1" } },
    { ...session, imported: true },
  ])
    assert.equal(deviceEligibleSession(other), false);
});

test("the draft is the owner's grants; a device of the session's own needs none", () => {
  const value = access([pixel, tablet, mine], { create: true });
  const draft = accessDraft(value);
  assert.deepEqual(draft, {
    devices: [{ deviceId: pixel.id, manage: false }],
    create: true,
  });
  assert.deepEqual(grantedIds(draft), [pixel.id]);
  // Its own device is always allowed and says why; it has no switch.
  assert.deepEqual(deviceGrantEntries(value.devices), [
    { id: pixel.id, name: "Pixel", locked: false, notes: [] },
    { id: tablet.id, name: "Tablet", locked: false, notes: [] },
    { id: mine.id, name: "Scratch", locked: true, notes: ["created by this session"] },
  ]);
  withLanguage("de", () =>
    assert.deepEqual(deviceGrantEntries([mine])[0].notes, [
      "von dieser Session angelegt",
    ]),
  );
  assert.deepEqual(manageRows(draft, value.devices), [
    { id: pixel.id, name: "Pixel", manage: false },
  ]);
  // A grant the owner gave to the session's own device stays in the draft.
  const granted = accessDraft(access([{ ...mine, assigned: true }]));
  assert.deepEqual(granted.devices, [{ deviceId: mine.id, manage: true }]);
  assert.deepEqual(manageRows(granted, [{ ...mine, assigned: true }]), []);
});

test("adding a device starts without reset and delete; a kept one keeps its switch", () => {
  let draft = withGranted(noAccess(), [pixel.id]);
  assert.deepEqual(draft, {
    devices: [{ deviceId: pixel.id, manage: false }],
    create: false,
  });
  draft = withManage(draft, pixel.id, true);
  draft = withGranted(draft, [pixel.id, tablet.id, tablet.id]);
  assert.deepEqual(draft.devices, [
    { deviceId: pixel.id, manage: true },
    { deviceId: tablet.id, manage: false },
  ]);
  // The switches follow the order of the device list, not of the clicks.
  assert.deepEqual(
    manageRows(withGranted(draft, [tablet.id, pixel.id]), [pixel, tablet]).map(
      (entry) => [entry.name, entry.manage],
    ),
    [
      ["Pixel", true],
      ["Tablet", false],
    ],
  );
  // Removed and added again, the permission is off again.
  draft = withGranted(withGranted(draft, [tablet.id]), [tablet.id, pixel.id]);
  assert.deepEqual(draft.devices, [
    { deviceId: tablet.id, manage: false },
    { deviceId: pixel.id, manage: false },
  ]);
  assert.equal(withManage(draft, "d-unknown00000", true).devices.length, 2);
});

test("a device that is gone drops from the draft; an unchanged draft stays itself", () => {
  const draft = {
    devices: [
      { deviceId: pixel.id, manage: true },
      { deviceId: tablet.id, manage: false },
    ],
    create: true,
  };
  assert.equal(prunedDraft(draft, [pixel, tablet]), draft);
  assert.deepEqual(prunedDraft(draft, [tablet]), {
    devices: [{ deviceId: tablet.id, manage: false }],
    create: true,
  });
  assert.deepEqual(prunedDraft(draft, []), { devices: [], create: true });
});

test("two drafts are the same whatever the order of their devices", () => {
  const a = {
    devices: [
      { deviceId: pixel.id, manage: true },
      { deviceId: tablet.id, manage: false },
    ],
    create: false,
  };
  const reversed = { ...a, devices: [...a.devices].reverse() };
  assert.equal(sameAccess(a, reversed), true);
  assert.equal(sameAccess(a, { ...a, create: true }), false);
  assert.equal(sameAccess(a, withManage(a, tablet.id, true)), false);
  assert.equal(sameAccess(a, withGranted(a, [pixel.id])), false);
  assert.equal(sameAccess(noAccess(), noAccess()), true);
});

test("a launch sends an access only when it grants something, and sums it up", () => {
  assert.equal(grantsAnything(noAccess()), false);
  assert.equal(launchSummary(noAccess()), "");
  const one = withGranted(noAccess(), [pixel.id]);
  assert.equal(grantsAnything(one), true);
  assert.equal(launchSummary(one), "1 Android device");
  const two = { ...withGranted(one, [pixel.id, tablet.id]), create: true };
  assert.equal(launchSummary(two), "2 Android devices, may create devices");
  const create = { devices: [], create: true };
  assert.equal(grantsAnything(create), true);
  assert.equal(launchSummary(create), "may create devices");
  withLanguage("de", () => {
    assert.equal(launchSummary(one), "1 Android-Gerät");
    assert.equal(launchSummary(two), "2 Android-Geräte, darf Geräte anlegen");
  });
});

test("the dialog says in words why it offers no choice", () => {
  assert.equal(accessBlocked(access([pixel])), "");
  assert.equal(
    accessBlocked(
      access([], { availability: { available: false, reason: "DEVICES_NOT_INSTALLED" } }),
    ),
    "The Android components are not installed.",
  );
  assert.match(
    accessBlocked(access([], { availability: { available: false, reason: null } })),
    /^Android devices are not available right now/,
  );
  assert.match(
    accessBlocked(access([pixel], { eligible: false })),
    /^Devices can be given to your own running coding sessions only/,
  );
  withLanguage("de", () =>
    assert.match(
      accessBlocked(access([pixel], { eligible: false })),
      /^Geräte bekommen nur deine eigenen laufenden Coding-Sessions/,
    ),
  );
});
