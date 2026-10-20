import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPreferences,
  inQuietHours,
  normalizePreferences,
  pushEventDefaults,
  updatePreferences,
  wantsEvent,
} from "../../server/features/notifications/push-preferences.js";
import {
  PushPresence,
  presenceWindowMs,
  routeView,
} from "../../server/features/notifications/push-presence.js";

test("new and older devices start at the event type only with the default events", () => {
  for (const stored of [undefined, null, {}, { level: "loud", events: { x: true } }]) {
    const preferences = normalizePreferences(stored);
    assert.deepEqual(preferences, defaultPreferences());
    assert.equal(preferences.level, "type");
  }
  assert.equal(pushEventDefaults["pipeline-completed"], false);
  assert.equal(pushEventDefaults["pipeline-failed"], true);
  assert.equal(pushEventDefaults.telegram, false);
  // The former single switch for ended runs carries over to both halves.
  const migrated = normalizePreferences({
    level: "label",
    events: { "pipeline-ended": false, question: false },
  });
  assert.equal(migrated.level, "label");
  assert.equal(migrated.events["pipeline-completed"], false);
  assert.equal(migrated.events["pipeline-failed"], false);
  assert.equal(migrated.events.question, false);
  assert.equal(migrated.events.permission, true);
  assert.equal(migrated.events["pipeline-ended"], undefined);
});

test("a change accepts only known fields with valid values", () => {
  const next = updatePreferences(undefined, {
    level: "preview",
    events: { telegram: true },
    quiet: { enabled: true, from: "21:30", to: "06:45", blockingThrough: true },
    timeZone: "Europe/Berlin",
    grouping: false,
  });
  assert.equal(next.level, "preview");
  assert.equal(next.events.telegram, true);
  assert.deepEqual(next.quiet, {
    enabled: true,
    from: "21:30",
    to: "06:45",
    blockingThrough: true,
  });
  assert.equal(next.timeZone, "Europe/Berlin");
  assert.equal(next.grouping, false);
  for (const input of [
    null,
    [],
    { level: "all" },
    { events: { "pipeline-ended": true } },
    { events: { question: "yes" } },
    { quiet: { from: "25:00" } },
    { quiet: { to: "7:00" } },
    { timeZone: "Mars/Olympus" },
    { grouping: 1 },
  ])
    assert.throws(() => updatePreferences(undefined, input), JSON.stringify(input));
});

const quiet = (from, to, timeZone = "UTC", blockingThrough = false) =>
  normalizePreferences({ quiet: { enabled: true, from, to, blockingThrough }, timeZone });
const utc = (time) => Date.parse(`2026-10-17T${time}:00Z`);

test("quiet hours follow the device's time zone and may run past midnight", () => {
  const overnight = quiet("22:00", "07:00");
  assert.equal(inQuietHours(overnight, utc("23:30")), true);
  assert.equal(inQuietHours(overnight, utc("03:00")), true);
  assert.equal(inQuietHours(overnight, utc("07:00")), false);
  assert.equal(inQuietHours(overnight, utc("21:59")), false);
  assert.equal(inQuietHours(overnight, utc("22:00")), true);
  const day = quiet("12:00", "14:00");
  assert.equal(inQuietHours(day, utc("13:00")), true);
  assert.equal(inQuietHours(day, utc("14:00")), false);
  assert.equal(inQuietHours(quiet("08:00", "08:00"), utc("08:00")), false);
  // 21:30 UTC is 23:30 in Berlin (summer time) and 17:30 in New York.
  assert.equal(
    inQuietHours(quiet("22:00", "07:00", "Europe/Berlin"), utc("21:30")),
    true,
  );
  assert.equal(
    inQuietHours(quiet("22:00", "07:00", "America/New_York"), utc("21:30")),
    false,
  );
  assert.equal(inQuietHours(defaultPreferences(), utc("23:30")), false);
});

test("quiet hours hold blocking items unless the device lets them through", () => {
  const night = utc("23:30");
  const held = quiet("22:00", "07:00");
  const through = quiet("22:00", "07:00", "UTC", true);
  for (const kind of ["question", "permission", "pipeline-gate", "agent-approval"]) {
    assert.equal(wantsEvent(held, { kind }, night), false, kind);
    assert.equal(wantsEvent(through, { kind }, night), true, kind);
  }
  assert.equal(wantsEvent(through, { kind: "session-completed" }, night), false);
  // System warnings and the test always arrive.
  for (const kind of ["disk-space", "github-token", "telegram-revocation", "test"])
    assert.equal(wantsEvent(held, { kind }, night), true, kind);
});

test("a device receives only the events it chose", () => {
  const preferences = defaultPreferences();
  const now = utc("12:00");
  assert.equal(wantsEvent(preferences, { kind: "pipeline-completed" }, now), false);
  assert.equal(wantsEvent(preferences, { kind: "pipeline-failed" }, now), true);
  // A check-in the paired Telegram chat delivered too notifies only on opt-in.
  assert.equal(wantsEvent(preferences, { kind: "agent-checkin" }, now), true);
  assert.equal(
    wantsEvent(preferences, { kind: "agent-checkin", telegram: true }, now),
    false,
  );
  preferences.events.telegram = true;
  assert.equal(
    wantsEvent(preferences, { kind: "agent-checkin", telegram: true }, now),
    true,
  );
});

test("visible views hold back pushes about them for 30 seconds", () => {
  let now = 1000;
  const presence = new PushPresence({ now: () => now });
  assert.equal(routeView("/inbox/question/r1"), "inbox");
  assert.equal(routeView("/sessions/s1/chat?x=1"), "session:s1");
  assert.equal(routeView("/agents/a1/chats/c1"), "agent:a1");
  assert.equal(routeView("/pipelines/runs/run-1"), "run:run-1");
  assert.equal(routeView("/settings/notifications"), null);
  assert.equal(routeView(42), null);
  presence.report("/sessions/s1/chat");
  const question = { kind: "question", inbox: { type: "question", id: "r1" } };
  assert.equal(presence.watching(question, "session:s1"), true);
  assert.equal(presence.watching(question, "session:s2"), false);
  presence.report("/inbox");
  assert.equal(presence.watching(question, "session:s2"), true);
  // The inbox shows waiting items only; a finished reply still notifies.
  assert.equal(presence.watching({ kind: "session-completed" }, "session:s2"), false);
  now += presenceWindowMs;
  assert.equal(presence.watching(question, "session:s1"), false);
});

test("presence reports are rate limited", () => {
  let now = 0;
  const presence = new PushPresence({ now: () => now });
  for (let index = 0; index < 120; index++) assert.equal(presence.report("/inbox"), true);
  assert.equal(presence.report("/inbox"), false);
  now += 60000;
  assert.equal(presence.report("/inbox"), true);
});

test("each person has her own presence report budget", () => {
  const now = 1000;
  const presence = new PushPresence({ now: () => now });
  for (let index = 0; index < 120; index++) presence.report("/inbox", "anna");
  assert.equal(presence.report("/inbox", "anna"), false);
  // The owner's reports still count, and hold back his pushes.
  assert.equal(presence.report("/inbox"), true);
  assert.equal(presence.seen("inbox", now), true);
  assert.equal(presence.report("/inbox", "ben"), true);
});
