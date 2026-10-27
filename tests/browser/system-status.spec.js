import { test, expect } from "@playwright/test";
import { cleanupSummary, details, summary } from "../helpers/system-status-fixture.js";

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
  await page.route("**/api/system-status/cleanup/summary", (route) =>
    route.fulfill({ json: cleanupSummary() }),
  );
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
    await expect(row).toHaveAttribute("aria-haspopup", "dialog");
    // Phones show three bars with their percentages; the details carry the figures.
    if (name === "phone") {
      for (const value of ["CPU34%", "RAM75%", "Disk60%"])
        await expect(row).toContainText(value);
      await expect(row.getByText("200 GB free of 500 GB")).toHaveCount(0);
      expect((await row.boundingBox()).height).toBeLessThan(130);
    } else {
      // CPU and RAM with sparklines, the disk, AgentPier's share and Details.
      await expect(row).toContainText("CPU12 cores34%");
      await expect(row).toContainText("RAM36 GB / 48 GB75%");
      await expect(row.getByText("200 GB free of 500 GB")).toBeVisible();
      await expect(row).toContainText("AgentPier: 2.5% CPU · 3 GB RAM");
      await expect(row).toContainText("Live · every 5 s");
      await expect(row.locator(".start-sparkline.cpu path")).toHaveCount(2);
      await expect(row.locator(".start-sparkline.memory path")).toHaveCount(2);
    }
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
    await expect(dialog).toContainText("This computer · 12 cores · 48 GB RAM · macOS");
    await expect(dialog).toContainText("Live · every 5 s");
    // The dialog opens on Load.
    const tabs = dialog.getByRole("tablist", { name: "System status sections" });
    await expect(tabs.getByRole("tab", { name: "Load" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tabs.getByRole("tab", { name: /Processes/ })).toContainText("13");
    await expect(tabs.getByRole("tab", { name: /Storage/ })).toContainText(
      "2.8 GB reclaimable",
    );
    await expect(
      dialog.getByRole("img", {
        name: "CPU, RAM and AgentPier CPU over the last hour; now 39%, 75% and 2%",
      }),
    ).toBeVisible();
    await expect(dialog.locator(".history-chart-gap")).toHaveCount(1);
    await expect(
      dialog.getByRole("heading", { name: "AgentPier's share" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("img", { name: "Computer CPU: 2.5% of 34%" }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`details-${name}.png`) });
    await tabs.getByRole("tab", { name: /Processes/ }).click();
    if (name === "desktop") {
      const table = dialog.getByRole("table");
      await expect(
        table.getByRole("rowheader", { name: /AgentPier server/ }),
      ).toBeVisible();
      await expect(table.getByRole("rowheader", { name: /Agent gateway/ })).toBeVisible();
      await expect(
        table.getByRole("rowheader", { name: /Fix the login flow/ }),
      ).toContainText("Claude Code · agent-pier");
    } else {
      await expect(dialog.getByRole("table")).toHaveCount(0);
      await expect(
        dialog.getByRole("listitem").filter({ hasText: "Fix the login flow" }),
      ).toContainText("Claude Code · agent-pier · 4 processes");
    }
    await page.screenshot({ path: testInfo.outputPath(`processes-${name}.png`) });
    await tabs.getByRole("tab", { name: /Storage/ }).click();
    await expect(dialog.getByText("CLI profiles", { exact: true })).toBeVisible();
    await expect(dialog.getByText("15 GB in total")).toBeVisible();
    await expect(dialog.getByText("Logs")).toBeHidden();
    await dialog.getByRole("button", { name: "2 more · 973 MB" }).click();
    await expect(dialog.getByText("Logs")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`storage-${name}.png`) });
    if (name === "phone") {
      // Every control of the sheet keeps the phone's 44px target.
      const small = await dialog.evaluate((node) =>
        [...node.querySelectorAll("button, a, [role=tab], .segment label")]
          .filter((item) => item.getClientRects().length)
          .filter((item) => item.getBoundingClientRect().height < 44)
          .map((item) => item.textContent.trim() || item.getAttribute("aria-label")),
      );
      expect(small).toEqual([]);
    }
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox.width).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}

test("low disk space needs you on the start page and opens Storage", async ({ page }) => {
  await routeStatus(page, { freePercent: 6, diskLow: true });
  await page.goto("/");
  const needs = page.getByRole("region", { name: "Needs you" });
  const card = needs.locator(".start-attention-card").filter({ hasText: "Disk space" });
  await expect(card).toContainText("Disk space is low");
  await expect(card).toContainText("Only 6% is free");
  await expect(card).toContainText("warning below 10%");
  // Nothing waits in the Inbox, so there is no link to it.
  await expect(needs.getByRole("link", { name: "Open Inbox" })).toHaveCount(0);
  await expect(page.locator(".start-disk.low")).toBeVisible();
  await card.getByRole("button", { name: "Free up space" }).click();
  const dialog = page.getByRole("dialog", { name: "System status" });
  await expect(dialog.getByRole("tab", { name: /Storage/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByRole("alert")).toContainText("Disk space is low");
});

test("on a phone low disk space is a compact row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeStatus(page, { freePercent: 6, diskLow: true });
  await page.goto("/");
  const row = page
    .getByRole("region", { name: "Needs you" })
    .getByRole("button", { name: /Disk space: Disk space is low/ });
  await expect(row).toBeVisible();
  expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(44);
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
  const bar = row.locator(".start-disk .system-meter-bar i");
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
    await expect(page.getByRole("button", { name: /System status/ })).toHaveCount(0);
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
    await expect(dialog.getByRole("heading", { name: "History" })).toBeVisible();
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

async function openDialog(page) {
  await routeStatus(page);
  await page.goto("/");
  await page.getByRole("button", { name: /System status/ }).click();
  const dialog = page.getByRole("dialog", { name: "System status" });
  await expect(dialog.getByRole("heading", { name: "History" })).toBeVisible();
  return dialog;
}

test("the tabs work by keyboard", async ({ page }) => {
  const dialog = await openDialog(page);
  const load = dialog.getByRole("tab", { name: "Load" });
  await load.focus();
  await page.keyboard.press("ArrowRight");
  const processes = dialog.getByRole("tab", { name: /Processes/ });
  await expect(processes).toBeFocused();
  await expect(processes).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel", { name: /Processes/ })).toContainText(
    "AgentPier core",
  );
  await page.keyboard.press("End");
  await expect(dialog.getByRole("tab", { name: /Storage/ })).toBeFocused();
  await expect(dialog.getByRole("heading", { name: "Free up space" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(load).toHaveAttribute("aria-selected", "true");
});

test("the history toggles its lines, switches range and shows values by key and pointer", async ({
  page,
}) => {
  const dialog = await openDialog(page);
  const chart = dialog.locator(".history-chart");
  await expect(chart.locator(".history-chart-line.chart-tone-memory")).toHaveCount(2);
  const ram = chart.getByRole("button", { name: "RAM" });
  await expect(ram).toHaveAttribute("aria-pressed", "true");
  await ram.click();
  await expect(ram).toHaveAttribute("aria-pressed", "false");
  await expect(chart.locator(".history-chart-line.chart-tone-memory")).toHaveCount(0);
  await ram.click();
  await expect(chart.locator(".history-chart-line.chart-tone-memory")).toHaveCount(2);

  // 15 minutes is a slice of the same data: the old run and its gap fall out.
  await dialog.getByRole("radio", { name: "15 min" }).check();
  await expect(chart.locator(".history-chart-gap")).toHaveCount(0);
  await expect(chart).toContainText("−15 min");
  await dialog.getByRole("radio", { name: "1 h" }).check();
  await expect(chart.locator(".history-chart-gap")).toHaveCount(1);

  const image = chart.getByRole("img");
  await image.focus();
  await page.keyboard.press("End");
  const tooltip = chart.locator(".history-chart-tooltip");
  await expect(tooltip).toContainText("CPU39%");
  await expect(chart.locator("[aria-live]")).toContainText("CPU 39%, RAM 75%");
  await page.keyboard.press("ArrowLeft");
  await expect(tooltip).toContainText("CPU38%");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(dialog).toBeVisible();

  const box = await chart.locator(".history-chart-plot").boundingBox();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await expect(tooltip).toContainText("CPU39%");
  await expect(tooltip).toContainText("AgentPier CPU2%");
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  await expect(tooltip).toHaveCount(0);
});

test("the processes sort inside each group and Open selects the session", async ({
  page,
}) => {
  const dialog = await openDialog(page);
  await dialog.getByRole("tab", { name: /Processes/ }).click();
  const table = dialog.getByRole("table");
  const cpu = table.getByRole("columnheader", { name: "CPU" });
  await expect(cpu).toHaveAttribute("aria-sort", "descending");
  const sessions = table
    .getByRole("rowgroup")
    .filter({ hasText: "Sessions · 3 running" });
  await expect(sessions.getByRole("rowheader").nth(1)).toContainText("Kanji quiz");
  await dialog.getByRole("radio", { name: "RAM" }).check();
  await expect(table.getByRole("columnheader", { name: "RAM" })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(cpu).not.toHaveAttribute("aria-sort", /.*/);
  await expect(sessions.getByRole("rowheader").nth(1)).toContainText(
    "Fix the login flow",
  );
  await dialog.getByRole("radio", { name: "Name" }).check();
  await expect(table.getByRole("columnheader", { name: "Part" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(sessions.getByRole("rowheader").nth(1)).toContainText(
    "Fix the login flow",
  );
  await expect(sessions.getByRole("rowheader").nth(3)).toContainText("Shell");
  await expect(
    table.getByRole("row").filter({ hasText: "AgentPier server" }).getByRole("link"),
  ).toHaveCount(0);
  await table.getByRole("link", { name: "Open Kanji quiz" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/s2/);
});
