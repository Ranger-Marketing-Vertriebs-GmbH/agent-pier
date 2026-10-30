import { test, expect } from "../helpers/browser-test.js";
import { serveLongLists } from "../helpers/long-lists-browser.js";

// The start page loads without moving (docs/system-status.md#start-page): every tile
// is in place from the first paint with skeletons in the shape the page had last time
// (web/features/dashboard/start-layout.js), and the content replaces them in place.
test.use({ locale: "en-GB" });

const tiles = {
  header: ".start-header",
  needsYou: ".start-attention",
  sessions: ".start-sessions",
  system: ".start-system",
  agents: ".start-agents",
  pipelines: ".start-pipelines, .start-tiles > :first-child",
  tools: ".start-tools, .start-tiles > :last-child",
  footer: ".start-footer",
};

// Holds the API reads that match `pattern` until `release()`; they then answer from
// the fixture.
async function hold(page, pattern = "**/api/**") {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await page.route(pattern, async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

async function boxes(page) {
  const result = {};
  for (const [name, selector] of Object.entries(tiles))
    result[name] = await page.locator(selector).first().boundingBox();
  return result;
}

async function loaded(page) {
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
  await expect(page.locator(".skeleton")).toHaveCount(0);
  await expect(page.locator(".start-sessions")).toContainText("Kanji-Quiz");
  await expect(page.locator(".start-agents")).toContainText("Buchhaltung");
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
])
  test(`tiles keep their place and size while the data loads (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await serveLongLists(page);
    // The first visit learns the page's shape; the next one starts in it.
    await page.goto("/");
    await loaded(page);
    const release = await hold(page);
    await page.reload();
    await expect(page.locator(".start-sessions .skeleton").first()).toBeVisible();
    await expect(page.locator(".start-agents .skeleton").first()).toBeVisible();
    await expect(page.locator(".start-attention .skeleton").first()).toBeVisible();
    const first = await boxes(page);
    release();
    await loaded(page);
    const after = await boxes(page);
    for (const tile of Object.keys(tiles)) {
      expect(first[tile], `${tile} at first paint`).not.toBeNull();
      for (const side of ["x", "y", "width", "height"])
        expect(
          Math.abs(first[tile][side] - after[tile][side]),
          `${tile} ${side}: ${first[tile][side]} → ${after[tile][side]}`,
        ).toBeLessThanOrEqual(2);
    }
  });

test("a slow tile shows skeletons until its data arrives, then the content", async ({
  page,
}) => {
  await serveLongLists(page);
  const release = await hold(page, "**/api/system-status");
  await page.goto("/");
  await expect(page.locator(".start-sessions")).toContainText("Kanji-Quiz");
  const tile = page.getByRole("button", { name: /System status/ });
  await expect(tile).toHaveAttribute("aria-busy", "true");
  await expect(tile.locator(".skeleton").first()).toBeVisible();
  // One quiet label for assistive technology, not a live region.
  await expect(tile.locator(".visually-hidden")).toHaveText("Loading");
  await expect(tile.locator("[role=status], [aria-live]")).toHaveCount(0);
  await expect(page.locator(".start-sessions")).not.toHaveAttribute("aria-busy");
  release();
  await expect(tile).toContainText("12 cores");
  await expect(tile).not.toHaveAttribute("aria-busy");
  await expect(tile.locator(".skeleton")).toHaveCount(0);
});

test("the shimmer moves, and stands still with reduced motion", async ({ page }) => {
  await serveLongLists(page);
  await hold(page, "**/api/system-status");
  await page.goto("/");
  const bar = page.locator(".start-system .skeleton").first();
  await expect(bar).toBeVisible();
  const animation = () => bar.evaluate((node) => getComputedStyle(node).animationName);
  expect(await animation()).toBe("skeleton-shimmer");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animation()).toBe("none");
});

test("agents found off keep their card once; the next visit leaves it out", async ({
  page,
}) => {
  await serveLongLists(page, { agents: false });
  await page.goto("/");
  // A first visit expects agents: the card stays and says they are off.
  const card = page.getByRole("region", { name: "Agents" });
  await expect(card).toContainText("Agents are off");
  await expect(card.getByRole("button", { name: "Enable agents" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New agent" })).toHaveCount(0);
  await card.getByRole("button", { name: "Enable agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents are off" })).toBeVisible();
  await page.goto("/");
  await expect(page.locator(".start-sessions")).toContainText("Kanji-Quiz");
  await expect(page.locator(".start-pipelines")).toContainText("Offline-Karten");
  await expect(card).toHaveCount(0);
  await expect(page.locator(".start-row-agents")).toHaveClass(/single/);
});
