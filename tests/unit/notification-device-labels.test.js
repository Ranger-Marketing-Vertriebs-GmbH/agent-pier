import test from "node:test";
import assert from "node:assert/strict";
import {
  currentDevice,
  describeDevice,
  deviceDisplayName,
  formatDeviceTime,
  isLegacyLabel,
} from "../../web/features/notifications/device-labels.js";
import { notificationCopy as de } from "../../web/lib/i18n/de/notifications.js";
import { notificationCopy as en } from "../../web/lib/i18n/en/notifications.js";

const agents = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  firefoxWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  edgeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0",
};
const name = (copy, input) => {
  const device = describeDevice(input);
  return copy.deviceName(device.browser, device.platform, device.app);
};

test("device names come from the browser and platform in both languages", () => {
  const cases = [
    [{ userAgent: agents.chromeMac }, "Chrome auf Mac", "Chrome on Mac"],
    [{ userAgent: agents.safariMac }, "Safari auf Mac", "Safari on Mac"],
    [
      { userAgent: agents.safariIphone, standalone: true },
      "Safari auf iPhone (App)",
      "Safari on iPhone (app)",
    ],
    [{ userAgent: agents.safariIphone }, "Safari auf iPhone", "Safari on iPhone"],
    [{ userAgent: agents.chromeIphone }, "Chrome auf iPhone", "Chrome on iPhone"],
    [{ userAgent: agents.firefoxLinux }, "Firefox auf Linux", "Firefox on Linux"],
    [{ userAgent: agents.firefoxWindows }, "Firefox auf Windows", "Firefox on Windows"],
    [{ userAgent: agents.edgeWindows }, "Edge auf Windows", "Edge on Windows"],
    [{ userAgent: agents.chromeAndroid }, "Chrome auf Android", "Chrome on Android"],
    [
      { userAgent: agents.edgeAndroid, standalone: true },
      "Edge auf Android (App)",
      "Edge on Android (app)",
    ],
    // iPadOS Safari reports a Mac; the touch screen identifies the iPad.
    [
      { userAgent: agents.safariMac, maxTouchPoints: 5, standalone: true },
      "Safari auf iPad (App)",
      "Safari on iPad (app)",
    ],
  ];
  for (const [input, german, english] of cases) {
    assert.equal(name(de, input), german, input.userAgent);
    assert.equal(name(en, input), english, input.userAgent);
  }
});

test("client hints take precedence over the frozen user agent string", () => {
  const hinted = {
    userAgent: agents.chromeMac,
    userAgentData: {
      platform: "Windows",
      brands: [
        { brand: "Not)A;Brand", version: "8" },
        { brand: "Chromium", version: "141" },
        { brand: "Microsoft Edge", version: "141" },
      ],
    },
  };
  assert.equal(name(en, hinted), "Edge on Windows");
  assert.equal(
    name(de, {
      userAgent: agents.chromeAndroid,
      userAgentData: { platform: "Linux", brands: [{ brand: "Chromium" }] },
    }),
    "Chrome auf Linux",
  );
  assert.equal(
    name(en, {
      userAgent: agents.chromeMac,
      userAgentData: { platform: "macOS", brands: [{ brand: "Google Chrome" }] },
    }),
    "Chrome on Mac",
  );
});

test("unknown browsers and platforms still produce a name", () => {
  assert.equal(name(de, { userAgent: "Fixture/1.0" }), "Browser");
  assert.equal(name(en, {}), "Browser");
  assert.equal(
    name(en, { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Fixture/1.0" }),
    "Browser on Linux",
  );
});

test("the current device reads navigator and the standalone display mode", () => {
  const device = currentDevice({
    navigator: { userAgent: agents.safariIphone, maxTouchPoints: 5 },
    matchMedia: (query) => ({ matches: query === "(display-mode: standalone)" }),
  });
  assert.deepEqual(device, { browser: "Safari", platform: "iPhone", app: true });
  assert.deepEqual(currentDevice({ navigator: { standalone: true } }), {
    browser: null,
    platform: null,
    app: true,
  });
});

test("legacy fixed names show the derived name only on the device itself", () => {
  const names = { derived: "Chrome on Mac", unnamed: "Unnamed device" };
  for (const label of ["Dieses Gerät", "This device", " This device ", "", undefined]) {
    assert.equal(
      deviceDisplayName({ label }, { ...names, current: true }),
      names.derived,
    );
    assert.equal(
      deviceDisplayName({ label }, { ...names, current: false }),
      names.unnamed,
    );
  }
  assert.equal(
    deviceDisplayName({ label: "iPhone" }, { ...names, current: true }),
    "iPhone",
  );
  assert.equal(isLegacyLabel("Dieses Gerät"), true);
  assert.equal(isLegacyLabel("Mein Gerät"), false);
});

test("device times are short and localised", () => {
  const now = new Date(2026, 9, 13, 21, 30);
  const today = new Date(2026, 9, 13, 21, 15).toISOString();
  const earlier = new Date(2026, 9, 12, 21, 13).toISOString();
  const lastYear = new Date(2025, 0, 2, 8, 5).toISOString();
  assert.equal(formatDeviceTime(today, { now, locale: "de-DE" }), "21:15");
  assert.equal(formatDeviceTime(today, { now, locale: "en-US" }), "9:15 PM");
  assert.equal(formatDeviceTime(earlier, { now, locale: "de-DE" }), "12. Okt., 21:13");
  assert.equal(formatDeviceTime(earlier, { now, locale: "en-US" }), "Oct 12, 9:13 PM");
  assert.equal(
    formatDeviceTime(lastYear, { now, locale: "de-DE" }),
    "2. Jan. 2025, 08:05",
  );
  assert.equal(
    formatDeviceTime(lastYear, { now, locale: "en-US" }),
    "Jan 2, 2025, 8:05 AM",
  );
  const morning = new Date(2026, 9, 13, 8, 5).toISOString();
  assert.equal(formatDeviceTime(morning, { now, locale: "de-DE" }), "08:05");
  assert.equal(formatDeviceTime(morning, { now, locale: "en-US" }), "8:05 AM");
  assert.equal(
    formatDeviceTime(today, { now, locale: "de-DE", date: true }),
    "13. Okt., 21:15",
  );
  assert.equal(formatDeviceTime("not a date", { now }), "");
  assert.equal(formatDeviceTime(undefined, { now }), "");
});
