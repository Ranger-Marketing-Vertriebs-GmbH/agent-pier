import { writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

test.use({ locale: "en-GB", viewport: { width: 390, height: 844 } });

test("startup stays visible and reports completed files while styles and authentication are delayed", async ({
  page,
  browserName,
}, testInfo) => {
  let releaseStyles, releaseAuth;
  const styles = new Promise((resolve) => {
    releaseStyles = resolve;
  });
  const auth = new Promise((resolve) => {
    releaseAuth = resolve;
  });
  await page.route("**/assets/*.css", async (route) => {
    await styles;
    await route.continue();
  });
  await page.route("**/auth/status", async (route) => {
    await auth;
    await route.fulfill({ json: { configured: true, authenticated: false } });
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    const screen = page.locator("#startup");
    await expect(screen).toBeVisible();
    await expect(screen).toContainText("Loading start files");
    await expect
      .poll(async () => Number(await screen.locator("progress").getAttribute("value")))
      .toBeGreaterThan(0);
    expect(Number(await screen.locator("progress").getAttribute("value"))).toBeLessThan(
      100,
    );
    // WebKit screenshot capture waits for fonts behind the deliberately held CSS.
    if (browserName === "chromium")
      await page.screenshot({ path: testInfo.outputPath("startup-progress.png") });
    releaseStyles();
    await expect(screen).toContainText("Checking sign-in");
    await expect(screen.locator("progress")).toBeHidden();
    releaseAuth();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(screen).toHaveCount(0);
  } finally {
    releaseStyles();
    releaseAuth();
  }
});

test("a failed start file shows a recoverable error and retry preserves the route", async ({
  page,
}) => {
  await page.route("**/auth/status", (route) =>
    route.fulfill({ json: { configured: true, authenticated: false } }),
  );
  await page.route("**/assets/*.css", (route) => route.abort());
  await page.goto("/settings?source=retry#retry", { waitUntil: "commit" });
  await expect(page.locator("#startup [role=alert]")).toContainText(
    "could not be loaded",
  );
  await page.unroute("**/assets/*.css");
  await page.locator("#startup").getByRole("link", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\?source=retry#retry$/);
});

test("startup respects the saved language before React loads", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "de"));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/*.css", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect(page.locator("#startup")).toContainText("Startdateien werden geladen");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
  } finally {
    release();
  }
});

test("the HTML start screen is usable even before its small loader arrives", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/startup-*.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/settings", { waitUntil: "commit" });
    await expect(page.locator("#startup")).toBeVisible();
    await expect(page.locator("#startup a")).toHaveAttribute("href", "");
    await expect(page.locator("#startup progress")).toBeHidden();
    expect(
      await page
        .locator("#startup")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe("rgb(16, 17, 20)");
  } finally {
    release();
  }
});

test("slow connection renders the start screen before the app and uses one request per start file", async ({
  page,
  context,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "Network throttling uses Chromium CDP");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 300,
    downloadThroughput: 160 * 1024,
    uploadThroughput: 80 * 1024,
  });
  const requests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/assets/"))
      requests.push(request.url());
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.locator("#startup")).toBeVisible();
  await expect(page.locator("#root")).toBeEmpty();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible({
    timeout: 25000,
  });
  await expect(page.locator("#startup")).toHaveCount(0);
  const timings = await page.evaluate(() => ({
    firstPaint: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
    appVisible: performance.now(),
    assets: performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname.startsWith("/assets/"))
      .map((entry) => ({
        name: new URL(entry.name).pathname,
        bytes: entry.transferSize,
        start: entry.startTime,
        end: entry.responseEnd,
      })),
  }));
  expect(timings.firstPaint).toBeGreaterThan(0);
  expect(timings.firstPaint).toBeLessThan(timings.appVisible);
  expect(new Set(requests).size).toBe(requests.length);
  const timingPath = testInfo.outputPath("slow-connection.json");
  await writeFile(timingPath, JSON.stringify(timings, null, 2));
  await testInfo.attach("slow-connection.json", {
    path: timingPath,
    contentType: "application/json",
  });
});

test("a stalled download never invents progress and offers a slow-connection hint", async ({
  page,
}) => {
  await page.clock.install();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/**", async (route) => {
    if (!new URL(route.request().url()).pathname.includes("/startup-")) await gate;
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    const screen = page.locator("#startup");
    await expect(screen).toContainText("Loading start files");
    await expect(screen.locator("progress")).toHaveAttribute("value", "0");
    await page.clock.fastForward(16000);
    await expect(screen).toContainText("This is taking a little longer");
    await expect(screen.locator("progress")).toHaveAttribute("value", "0");
  } finally {
    release();
  }
});

test("a failed entry module shows an error instead of waiting indefinitely", async ({
  page,
}) => {
  await page.route("**/assets/index-*.js", (route) => route.abort());
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.locator("#startup [role=alert]")).toContainText(
    "could not be loaded",
  );
  await expect(page.locator("#startup progress")).toBeHidden();
});

test("browsers without native module preloads start without a misleading percentage", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const supports = DOMTokenList.prototype.supports;
    DOMTokenList.prototype.supports = function (token) {
      return token === "modulepreload" ? false : supports.call(this, token);
    };
  });
  await page.route("**/auth/status", (route) =>
    route.fulfill({ json: { configured: true, authenticated: false } }),
  );
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/*.css", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect(page.locator("#startup")).toContainText("Starting the app");
    await expect(page.locator("#startup progress")).toBeHidden();
    release();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#startup")).toHaveCount(0);
  } finally {
    release();
  }
});
