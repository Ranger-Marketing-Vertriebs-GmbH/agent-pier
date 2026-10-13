// Names and times for push devices. The name comes from the browser's own brand and
// platform hints (User-Agent Client Hints, else the User-Agent string) and nothing else.

// Earlier versions stored this fixed text as the name of every new device.
const legacyLabels = new Set(["Dieses Gerät", "This device"]);

const brandNames = [
  ["Microsoft Edge", "Edge"],
  ["Opera", "Opera"],
  ["Brave", "Brave"],
  ["Google Chrome", "Chrome"],
];
const userAgentBrowsers = [
  [/EdgiOS\/|EdgA?\//, "Edge"],
  [/OPR\/|OPiOS\//, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/FxiOS\/|Firefox\//, "Firefox"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
];
const hintPlatforms = {
  macos: "Mac",
  windows: "Windows",
  linux: "Linux",
  android: "Android",
  "chrome os": "ChromeOS",
  chromeos: "ChromeOS",
  ios: "iPhone",
};

function browserName(userAgent, brands) {
  for (const [brand, name] of brandNames) if (brands.includes(brand)) return name;
  for (const [pattern, name] of userAgentBrowsers)
    if (pattern.test(userAgent)) return name;
  return null;
}

function platformName(userAgent, hint, maxTouchPoints) {
  if (/iPad/.test(userAgent)) return "iPad";
  if (/iPhone|iPod/.test(userAgent)) return "iPhone";
  const hinted = hintPlatforms[String(hint || "").toLowerCase()];
  if (hinted) return hinted;
  if (/Android/.test(userAgent)) return "Android";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Windows/.test(userAgent)) return "Windows";
  // iPadOS Safari reports a Mac; only the touch screen tells them apart.
  if (/Macintosh|Mac OS X/.test(userAgent)) return maxTouchPoints > 1 ? "iPad" : "Mac";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

/** `{ browser, platform, app }` of a browser; `null` where a part is unknown. */
export function describeDevice({
  userAgent = "",
  userAgentData,
  standalone = false,
  maxTouchPoints = 0,
} = {}) {
  const brands = (userAgentData?.brands || []).map((entry) => entry.brand);
  return {
    browser: browserName(userAgent, brands),
    platform: platformName(userAgent, userAgentData?.platform, maxTouchPoints),
    app: Boolean(standalone),
  };
}

/** The browser this page runs in. */
export function currentDevice(browser = globalThis) {
  const navigator = browser.navigator || {};
  let standalone = navigator.standalone === true;
  try {
    standalone ||= browser.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    // Without media queries the page is treated as running in a browser tab.
  }
  return describeDevice({
    userAgent: navigator.userAgent,
    userAgentData: navigator.userAgentData,
    standalone,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

export function isLegacyLabel(label) {
  return legacyLabels.has(String(label ?? "").trim());
}

/**
 * The name a device row shows. A missing or legacy name becomes the derived name on
 * the device itself and `unnamed` everywhere else.
 */
export function deviceDisplayName(entry, { current, derived, unnamed }) {
  const label = String(entry?.label ?? "").trim();
  if (label && !isLegacyLabel(label)) return label;
  return current ? derived : unnamed;
}

// The locale's own short time decides between "08:05" and "8:05 AM".
const hourStyle = (locale) =>
  new Intl.DateTimeFormat(locale, { timeStyle: "short" })
    .formatToParts(new Date(2000, 0, 1, 8))
    .find((part) => part.type === "hour").value.length === 2
    ? "2-digit"
    : "numeric";
const sameDay = (left, right) => left.toDateString() === right.toDateString();

/**
 * "21:15" today (unless `date` asks for the day too), "13. Okt., 21:13" this year,
 * with the year before that.
 */
export function formatDeviceTime(
  value,
  { now = new Date(), locale = "de-DE", date: withDate = false } = {},
) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  const time = { hour: hourStyle(locale), minute: "2-digit" };
  if (!withDate && sameDay(date, now)) return date.toLocaleTimeString(locale, time);
  const year = date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" };
  return date.toLocaleString(locale, {
    day: "numeric",
    month: "short",
    ...year,
    ...time,
  });
}
