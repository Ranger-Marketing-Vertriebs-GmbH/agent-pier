import { test, expect } from "@playwright/test";

test.use({ locale: "en-GB" });

const GB = 1024 ** 3;
function summary({ freePercent = 40, diskLow = false } = {}) {
  return {
    sampledAt: new Date().toISOString(),
    cpu: { percent: 34, cores: 12, load: [4.68, 5.61, 6.17] },
    memory: { totalBytes: 48 * GB, usedBytes: 36 * GB, percent: 75 },
    disk: {
      totalBytes: 500 * GB,
      freeBytes: 5 * freePercent * GB,
      usedBytes: (500 - 5 * freePercent) * GB,
      freePercent,
    },
    agentPier: { cpuPercent: 2.5, rssBytes: 3 * GB },
    warning: { diskLow, thresholdPercent: 10 },
  };
}
function details(options) {
  const now = Date.now();
  return {
    ...summary(options),
    processes: [
      { kind: "server", processes: 3, rssBytes: 0.2 * GB, cpuPercent: 0.4 },
      { kind: "gateway", processes: 2, rssBytes: 0.8 * GB, cpuPercent: 1.1 },
      {
        kind: "session",
        id: "s1",
        name: "Fix the login flow",
        tool: "claude",
        processes: 4,
        rssBytes: 2 * GB,
        cpuPercent: 1,
      },
    ],
    history: Array.from({ length: 20 }, (_, index) => ({
      t: now - (19 - index) * 30_000,
      cpu: 20 + index,
      memory: 70 + index / 4,
      agentCpu: 2,
    })),
    areas: {
      state: "ready",
      computedAt: new Date(now - 60_000).toISOString(),
      partial: false,
      totalBytes: 15 * GB,
      areas: [
        { id: "profiles", bytes: 12 * GB },
        { id: "clis", bytes: GB },
        { id: "agentAttachments", bytes: 0.1 * GB },
        { id: "other", bytes: 0.9 * GB },
      ],
    },
  };
}
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
    await expect(table.getByRole("rowheader", { name: "Agent Gateway" })).toBeVisible();
    await expect(
      table.getByRole("rowheader", { name: /Fix the login flow/ }),
    ).toContainText("Claude Code");
    await expect(dialog.getByRole("img", { name: "CPU: currently 39%" })).toBeVisible();
    await expect(dialog.getByText("CLI profiles")).toBeVisible();
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
