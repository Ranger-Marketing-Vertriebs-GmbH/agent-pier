import { test, expect } from "@playwright/test";
import { details, summary } from "../helpers/system-status-fixture.js";

test.use({ locale: "en-GB" });

async function routeStatus(page, options) {
  const calls = { summary: 0, details: 0 };
  await page.route("**/api/system-status", (route) => {
    calls.summary++;
    return route.fulfill({ json: summary(options) });
  });
  await page.route("**/api/system-status/details", (route) => {
    calls.details++;
    return route.fulfill({ json: details(options) });
  });
  return calls;
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`the start page shows disk, CPU and RAM and opens the details (${name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await routeStatus(page);
    await page.goto("/");
    const row = page.getByRole("button", { name: /System status/ });
    await expect(row).toContainText("Disk");
    for (const value of ["Disk60%", "CPU34%", "RAM75%"])
      await expect(row).toContainText(value);
    // Phones show the bars with their percentages; the details carry the figures.
    const figures = row.getByText("200 GB free of 500 GB");
    if (name === "phone") await expect(figures).toBeHidden();
    else {
      await expect(figures).toBeVisible();
      await expect(row).toContainText("34% of 12 cores");
      await expect(row).toContainText("36 GB of 48 GB");
    }
    expect((await row.boundingBox()).height).toBeLessThan(name === "phone" ? 130 : 100);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`start-${name}.png`) });
    const box = await row.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    await row.click();
    const dialog = page.getByRole("dialog", { name: "System status" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "AgentPier's share" }),
    ).toBeVisible();
    const table = dialog.getByRole("table");
    await expect(
      table.getByRole("rowheader", { name: "AgentPier server" }),
    ).toBeVisible();
    await expect(table.getByRole("rowheader", { name: "Agent gateway" })).toBeVisible();
    await expect(
      table.getByRole("rowheader", { name: /Fix the login flow/ }),
    ).toContainText("Claude Code");
    await expect(dialog.getByRole("img", { name: "CPU: currently 39%" })).toBeVisible();
    await expect(dialog.getByText("CLI profiles", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Agent attachments")).toBeVisible();
    await expect(dialog.getByText("15 GB in total")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`details-${name}.png`) });
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox.width).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}

test("low disk space shows a warning on the start page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeStatus(page, { freePercent: 6, diskLow: true });
  await page.goto("/");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Disk space is low");
  await expect(alert).toContainText("Only 6% is free");
  await expect(alert).toContainText("warning below 10%");
});

test("the start page polls the status only while it is visible", async ({ page }) => {
  const calls = await routeStatus(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /System status/ })).toContainText("Disk");
  await expect.poll(() => calls.summary, { timeout: 12_000 }).toBeGreaterThan(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = calls.summary;
  await page.waitForTimeout(6000);
  expect(calls.summary).toBe(hidden);
});

test("an unknown disk share shows a dash, not a full bar", async ({ page }) => {
  const unknown = { totalBytes: 0, freeBytes: 0, usedBytes: 0, freePercent: null };
  await page.route("**/api/system-status", (route) =>
    route.fulfill({ json: { ...summary(), disk: unknown } }),
  );
  await page.goto("/");
  const row = page.getByRole("button", { name: /System status/ });
  await expect(row).toContainText("Disk–");
  const bar = row.locator(".system-meter-bar i").first();
  expect(await bar.evaluate((node) => node.style.width)).toBe("0%");
  await expect(row.locator("div")).toHaveCount(0);
});

for (const [name, answer] of [
  ["an unexpected answer", { json: {} }],
  ["a failed request", { status: 500, json: { error: "unavailable" } }],
])
  test(`${name} hides the status row quietly`, async ({ page }) => {
    await page.route("**/api/system-status", (route) => route.fulfill(answer));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your tools" })).toBeVisible();
    await expect(page.getByRole("region", { name: "System status" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

// AGENTPIER-245: the start page showed through the open details. The dialog stays the
// same node across polls, its backdrop is opaque, and the page behind neither scrolls
// nor shows its updates (sessions here change on every workspace poll).
async function routeChangingSessions(page) {
  let round = 0;
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    round++;
    json.sessions = Array.from({ length: 2 + (round % 3) }, (_, index) => ({
      id: `s${index}`,
      name: round % 2 ? `Fix the login flow ${index}` : `Review the API docs ${index}`,
      tool: "claude",
      cwd: `/work/s${index}`,
      status: "running",
      activity: { state: (round + index) % 2 ? "working" : "waiting", label: "Busy" },
    }));
    await route.fulfill({ response, json });
  });
  return () => round;
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 700 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`the open details stay put and hide the changing start page (${name})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(45_000);
    await page.setViewportSize(viewport);
    const calls = await routeStatus(page);
    const rounds = await routeChangingSessions(page);
    await page.goto("/");
    await page.getByRole("button", { name: /System status/ }).click();
    const dialog = page.getByRole("dialog", { name: "System status" });
    await expect(dialog.getByText("15 GB in total")).toBeVisible();
    const pageTop = await page.evaluate(() => {
      window.__statusDialog = document.querySelector("dialog");
      return document.documentElement.scrollTop;
    });
    expect(
      await dialog.evaluate((node) => [
        getComputedStyle(node).backgroundColor,
        getComputedStyle(node, "::backdrop").backgroundColor,
      ]),
    ).toEqual(["rgb(27, 28, 32)", "rgb(9, 10, 14)"]);
    // Wheel past the end of the dialog, then over the backdrop beside or above it.
    const box = await dialog.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 8; step++) await page.mouse.wheel(0, 600);
    await page.mouse.move(Math.max(4, box.x / 2), Math.max(4, box.y / 2));
    for (let step = 0; step < 4; step++) await page.mouse.wheel(0, 600);
    // The backdrop beside (desktop) or above (phone) the dialog, over several polls.
    const clip =
      name === "desktop"
        ? { x: 0, y: 0, width: Math.floor(box.x) - 8, height: viewport.height }
        : { x: 0, y: 0, width: viewport.width, height: Math.floor(box.y) - 8 };
    const first = await page.screenshot({ clip });
    const polled = calls.details;
    const changed = rounds();
    for (let shot = 0; shot < 6; shot++) {
      await page.waitForTimeout(1_000);
      expect((await page.screenshot({ clip })).equals(first)).toBe(true);
    }
    await expect
      .poll(() => calls.details, { timeout: 15_000 })
      .toBeGreaterThan(polled + 1);
    expect(rounds()).toBeGreaterThan(changed + 1);
    expect((await page.screenshot({ clip })).equals(first)).toBe(true);
    expect(
      await page.evaluate(() => ({
        same: document.querySelector("dialog") === window.__statusDialog,
        open: window.__statusDialog.open,
        pageTop: document.documentElement.scrollTop,
      })),
    ).toEqual({ same: true, open: true, pageTop });
    await page.screenshot({ path: testInfo.outputPath(`details-open-${name}.png`) });
  });
}
