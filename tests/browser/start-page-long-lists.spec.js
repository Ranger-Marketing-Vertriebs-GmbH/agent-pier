import { test, expect } from "@playwright/test";
import { serveLongLists } from "../helpers/long-lists-browser.js";

// The start page with a busy host: 24 sessions (18 running, 6 stopped) and 14 agents
// (tests/fixtures/long-lists.js). Browsing never writes anything.
test.use({ locale: "en-GB", viewport: { width: 1440, height: 900 } });

const sessionsCard = (page) => page.getByRole("region", { name: /^Sessions/ });
const agentsCard = (page) => page.getByRole("region", { name: /^Agents/ });
const sessionRows = (card) => card.locator("tbody tr");

test("above the fold: header, Needs you, six sessions with waiting first and the system tile", async ({
  page,
}, testInfo) => {
  const fixture = await serveLongLists(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Good (morning|evening)\.$|^Hello\.$/,
  );
  await expect(page.locator(".page-header-eyebrow")).toContainText("Overview · ");
  const summary = page.locator(".page-header-summary");
  await expect(summary).toContainText("5 sessions working");
  await expect(summary).toContainText("3 agents working");
  await expect(summary).toContainText("2 things need you");
  const needs = page.getByRole("region", { name: "Needs you" });
  await expect(needs.locator(".start-attention-card")).toHaveCount(2);
  await expect(needs).toContainText("Risk-Gate: japanischa · Dependency-Update");
  await expect(needs.getByRole("button", { name: "Decide" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Your tools/ })).toHaveText(
    "Your tools · 4 of 4 ready · 3 profiles",
  );
  const card = sessionsCard(page);
  await expect(card.getByRole("heading")).toHaveText("Sessions 18 running · 6 stopped");
  await expect(sessionRows(card)).toHaveCount(6);
  await expect(sessionRows(card).nth(0)).toContainText("Kanji-Quiz");
  await expect(sessionRows(card).nth(1)).toContainText("Migration prüfen");
  await expect(sessionRows(card).nth(0)).toContainText("Waiting");
  await expect(sessionRows(card).nth(2)).toContainText("Working");
  await expect(card).toContainText("6 of 18 · waiting first, then by latest activity");
  const tile = page.getByRole("button", { name: /System status/ });
  for (const element of [
    page.getByRole("heading", { level: 1 }),
    needs,
    sessionRows(card).nth(5),
    tile,
  ]) {
    const box = await element.boundingBox();
    expect(box.y + box.height, "above the fold").toBeLessThanOrEqual(900);
  }
  await expect(tile).toContainText("12 cores");
  await expect(tile.locator(".start-sparkline path").first()).toBeAttached();
  await expect(card.locator("tbody tr").nth(0)).toContainText("MB");
  await page.screenshot({ path: testInfo.outputPath("start-page-desktop.png") });
  await page.screenshot({
    path: testInfo.outputPath("start-page-desktop-full.png"),
    fullPage: true,
  });
  expect(fixture.writes).toEqual([]);
});

test("filters, search and show more work by keyboard and fold again", async ({
  page,
}) => {
  await serveLongLists(page);
  await page.goto("/");
  const card = sessionsCard(page);
  const more = card.getByRole("button", { name: "Show 12 more" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("button", { name: "Show less" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(sessionRows(card)).toHaveCount(18);
  // The list scrolls inside the card; the header row stays in view.
  const body = card.locator(".start-list-body");
  const box = await body.boundingBox();
  expect(box.height).toBeLessThanOrEqual(471);
  await body.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await expect(card.locator("thead th").first()).toBeInViewport();
  // A chip by keyboard folds the list and filters it.
  const chips = card.getByRole("group", { name: "Filter sessions" });
  const working = chips.getByRole("button", { name: "Working 5" });
  await working.focus();
  await page.keyboard.press("Space");
  await expect(working).toHaveAttribute("aria-pressed", "true");
  await expect(sessionRows(card)).toHaveCount(5);
  await expect(card.getByRole("button", { name: /Show .* more|Show less/ })).toHaveCount(
    0,
  );
  // Stopped sessions show only under their own chip.
  await chips.getByRole("button", { name: "Stopped 6" }).click();
  await expect(sessionRows(card)).toHaveCount(6);
  await expect(sessionRows(card).first()).toContainText("Ended");
  await chips.getByRole("button", { name: "Running 18" }).click();
  await card.getByRole("button", { name: "Show 12 more" }).click();
  // Searching folds the list again and the counts follow the search.
  const search = card.getByRole("searchbox", { name: "Name or project" });
  await search.fill("bilen");
  await expect(sessionRows(card)).toHaveCount(3);
  await expect(chips.getByRole("button", { name: "Running 3" })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Waiting for you 1" })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Stopped 1" })).toBeVisible();
  await search.fill("bilen claude");
  await expect(sessionRows(card)).toHaveCount(2);
  await search.fill("nothing like this");
  await expect(card).toContainText("No session matches the filter and search.");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(sessionRows(card)).toHaveCount(6);
});

test("agents sort needing you first, filter and show five", async ({ page }) => {
  await serveLongLists(page);
  await page.goto("/");
  const card = agentsCard(page);
  const rows = card.locator(".start-agent-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText("Buchhaltung");
  await expect(rows.nth(1)).toContainText("Code-Review");
  await expect(rows.nth(1)).toContainText("Lead, 2 members");
  await expect(card).toContainText("Agent service running");
  await card.getByRole("button", { name: "Show 9 more" }).click();
  await expect(rows).toHaveCount(14);
  await card.getByRole("searchbox", { name: "Search agents" }).fill("zzz");
  await expect(card).toContainText("No agent matches the filter and search.");
  await card.getByRole("searchbox", { name: "Search agents" }).fill("");
  await card.getByRole("button", { name: "Ready 9" }).click();
  await expect(rows).toHaveCount(5);
  await expect(card.getByRole("button", { name: "Show 4 more" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  // Pipelines: running, awaiting a decision, failed.
  const pipelines = page.getByRole("region", { name: "Pipelines" });
  await expect(pipelines.locator(".start-run")).toHaveCount(3);
  await expect(pipelines.locator(".start-run").first()).toContainText(
    "hoppkit-api · Offline-Karten",
  );
  await expect(pipelines.locator(".start-run").first()).toContainText(
    "Stage 3 of 5 · Verifikation · for 18 min",
  );
  await expect(pipelines.locator(".start-run").nth(2)).toContainText("1 h ago");
});

test("the gateway row counts the agents in System status", async ({ page }) => {
  await serveLongLists(page);
  await page.goto("/");
  await page.getByRole("button", { name: /System status/ }).click();
  const dialog = page.getByRole("dialog", { name: "System status" });
  await dialog.getByRole("tab", { name: /Processes/ }).click();
  await expect(dialog).toContainText("OpenClaw · 14 agents");
});

test.describe("in German", () => {
  test.use({ locale: "de-DE" });

  test("the cards use the app's German state words", async ({ page }, testInfo) => {
    await serveLongLists(page, { language: "de" });
    await page.goto("/");
    await expect(page.locator(".page-header-eyebrow")).toContainText("Übersicht · ");
    await expect(page.getByRole("region", { name: "Braucht dich" })).toBeVisible();
    const card = page.getByRole("region", { name: /^Sessions/ });
    await expect(card.getByRole("heading")).toHaveText("Sessions 18 laufen · 6 gestoppt");
    for (const chip of ["Laufend 18", "Wartet auf dich 2", "Arbeitet 5", "Bereit 10"])
      await expect(card.getByRole("button", { name: chip })).toBeVisible();
    await expect(card).toContainText(
      "6 von 18 · wartende zuerst, dann nach letzter Aktivität",
    );
    await expect(card.getByRole("button", { name: "12 weitere anzeigen" })).toBeVisible();
    await expect(page.getByRole("region", { name: /^Agenten/ })).toContainText(
      "Lead, 2 Mitglieder",
    );
    await page.screenshot({ path: testInfo.outputPath("start-page-desktop-de.png") });
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a failed agent open shows its error on the phone too", async ({ page }) => {
    const fixture = await serveLongLists(page);
    await page.goto("/");
    const card = agentsCard(page);
    await card.locator(".start-agent-row").filter({ hasText: "Recherche" }).click();
    await expect(card.getByRole("alert")).toContainText("read-only fixture");
    expect(fixture.writes).toEqual([
      "POST /api/assistants/agent-recherche/conversations",
    ]);
  });

  test("four rows each and show all, compact Needs you and summary tiles", async ({
    page,
  }, testInfo) => {
    await serveLongLists(page);
    await page.goto("/");
    const card = sessionsCard(page);
    await expect(card.locator(".start-row")).toHaveCount(4);
    // The search sits above the chips with a full tap target and filters the rows.
    const search = card.getByRole("searchbox", { name: "Name or project" });
    const chips = card.getByRole("group", { name: "Filter sessions" });
    const searchBox = await search.boundingBox();
    expect(searchBox.height).toBeGreaterThanOrEqual(44);
    expect(searchBox.y).toBeLessThan((await chips.boundingBox()).y);
    await expect(card.getByRole("button", { name: /Show .* more/ })).toHaveCount(0);
    const all = card.getByRole("button", { name: "Show all 18 sessions" });
    await expect(all).toBeVisible();
    const agents = agentsCard(page);
    await expect(agents.locator(".start-agent-row")).toHaveCount(4);
    await expect(agents.getByRole("button", { name: "All 14 agents" })).toBeVisible();
    const needs = page.getByRole("region", { name: "Needs you" });
    await expect(needs.locator(".start-attention-row")).toHaveCount(2);
    // Needs you, then the system status, then the sessions.
    const tops = await Promise.all(
      [needs, page.getByRole("button", { name: /System status/ }), card].map(
        async (part) => (await part.boundingBox()).y,
      ),
    );
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    await expect(page.getByRole("link", { name: /Pipelines/ })).toContainText(
      "1 running",
    );
    await expect(page.getByRole("link", { name: /Your tools/ })).toContainText(
      "4 of 4 ready · 3 profiles",
    );
    for (const name of ["Session", "Agent"]) {
      const box = await page
        .locator(".page-header-actions")
        .getByRole("button", { name, exact: true })
        .boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(48);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    // Every control of the page keeps the phone's 44px target.
    const small = await page.locator(".start-page").evaluate((node) =>
      [...node.querySelectorAll("button, a, input")]
        .filter((item) => item.getClientRects().length)
        .filter((item) => item.getBoundingClientRect().height < 44)
        .map((item) => item.textContent.trim() || item.getAttribute("aria-label")),
    );
    expect(small).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("start-page-phone.png"),
      fullPage: true,
    });
    await search.fill("bilen");
    await expect(card.locator(".start-row")).toHaveCount(3);
    await expect(card.getByRole("button", { name: /Show all/ })).toHaveCount(0);
    await search.fill("");
    await expect(
      agentsCard(page).getByRole("searchbox", { name: "Search agents" }),
    ).toBeVisible();
    await all.click();
    await expect(page.locator(".sidebar.open, .app .sidebar")).toBeVisible();
  });
});

test("Open inbox sits beside the Needs you cards while Inbox items wait", async ({
  page,
}) => {
  await serveLongLists(page);
  await page.goto("/");
  const needs = page.getByRole("region", { name: "Needs you" });
  await needs.getByRole("link", { name: "Open inbox" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test.describe("phone without agents", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the agents card waits for the list and shows no bare count", async ({ page }) => {
    const fixture = await serveLongLists(page);
    fixture.agents.assistants.length = 0;
    fixture.agents.activity = {};
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route("**/api/assistants", async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto("/");
    await expect(sessionsCard(page)).toBeVisible();
    await expect(agentsCard(page)).toHaveCount(0);
    release();
    const card = agentsCard(page);
    await expect(card).toContainText("No agent yet");
    await expect(card.getByRole("heading")).toHaveText("Agents");
  });
});

test("a failed Inbox read is tried again", async ({ page }) => {
  await serveLongLists(page);
  let reads = 0;
  await page.route("**/api/inbox", (route) =>
    ++reads === 1
      ? route.fulfill({ status: 500, json: { error: "unavailable" } })
      : route.fallback(),
  );
  await page.goto("/");
  const needs = page.getByRole("region", { name: "Needs you" });
  await expect(needs).toContainText("Risk-Gate: japanischa · Dependency-Update", {
    timeout: 10_000,
  });
  expect(reads).toBeGreaterThanOrEqual(2);
});
