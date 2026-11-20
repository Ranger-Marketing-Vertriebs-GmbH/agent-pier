// The update notice on phone pages with their own header (AGENTPIER-420): it sits
// below the page header and its tabs, so the menu button, the title and the tabs stay
// reachable (docs/startup-loading.md, Caching and updates).
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { inboxFixture } from "./inbox-fixture.js";
import { operationsFixture } from "./operations-fixture.js";

const pages = [
  ["inbox", "/inbox", inboxFixture],
  ["settings", "/settings", operationsFixture],
];

// Whether the element's centre is hit by itself (not covered by the notice).
const reachable = (locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return Boolean(hit && (element === hit || element.contains(hit)));
  });

for (const width of [320, 390])
  for (const [name, path, fixture] of pages)
    test(`${name} at ${width} px: the update notice leaves the page header free`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await fixture(page);
      await page.goto(baseURL + path);
      const header = page.locator(".settings-shell-header");
      const menu = header.getByRole("button", { name: "Navigation öffnen" });
      const tab = header.getByRole("tab").first();
      await expect(menu).toBeVisible();
      await expect(tab).toBeVisible();
      await page.evaluate(() => dispatchEvent(new Event("agentpier-update-available")));
      const notice = page.locator(".update-notice");
      await expect(notice).toBeVisible();
      const headerBox = await header.boundingBox();
      await expect
        .poll(async () => (await notice.boundingBox()).y)
        .toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
      expect(await reachable(menu)).toBe(true);
      expect(await reachable(header.getByRole("heading", { level: 1 }))).toBe(true);
      expect(await reachable(tab)).toBe(true);
      // Reload and dismiss stay inside the screen.
      const box = await notice.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await expect(notice.getByRole("button", { name: "Neu laden" })).toBeVisible();
    });
