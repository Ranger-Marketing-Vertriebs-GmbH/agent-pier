import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
async function fixture(page) {
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        tools: [{ id: "codex", installed: true, name: "Codex" }],
        accounts: Array.from({ length: 16 }, (_, i) => ({
          id: `account-${i}`,
          tool: "codex",
          name: `Profil ${i}`,
          kind: "managed",
        })),
        sessions: [],
        home: "/tmp",
      },
    }),
  );
  await page.goto(base);
  await page
    .locator(page.viewportSize().width < 701 ? ".mobile-header" : ".sidebar")
    .getByRole("button", { name: "Neue Sitzung", exact: true })
    .click();
}
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1152, height: 640, zoom: 1.25 },
  { width: 390, height: 844 },
  { width: 390, height: 500 },
])
  test(`launch choices stay anchored inside scrolled dialog at ${viewport.width}x${viewport.height}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport,
      hasTouch: viewport.width === 390,
      isMobile: viewport.width === 390,
    });
    try {
      const page = await context.newPage();
      await fixture(page);
      if (viewport.zoom)
        await page.evaluate((zoom) => {
          document.body.style.zoom = zoom;
        }, viewport.zoom);
      for (const name of ["CLI", "Zugang", "Startmodus"]) {
        const field = page.getByLabel(name, { exact: true });
        await field.scrollIntoViewIfNeeded();
        await field[viewport.width === 390 ? "tap" : "click"]();
        const list = page.getByRole("listbox", { name: `${name}: Optionen` });
        await expect(list).toBeVisible();
        const anchor = await field.boundingBox(),
          box = await list.boundingBox(),
          dialog = await page.getByRole("dialog").boundingBox();
        expect(
          Math.min(
            Math.abs(box.y + box.height - anchor.y),
            Math.abs(box.y - anchor.y - anchor.height),
          ),
        ).toBeLessThanOrEqual(8);
        expect(box.x).toBeGreaterThanOrEqual(dialog.x);
        expect(box.x + box.width).toBeLessThanOrEqual(dialog.x + dialog.width + 1);
        expect(box.y).toBeGreaterThanOrEqual(Math.max(0, dialog.y));
        expect(box.y + box.height).toBeLessThanOrEqual(
          Math.min(viewport.height, dialog.y + dialog.height),
        );
        await page.getByRole("dialog").evaluate((el) => {
          el.scrollTop += 12;
        });
        await expect
          .poll(async () => {
            const fieldBox = await field.boundingBox(),
              listBox = await list.boundingBox();
            return Math.min(
              Math.abs(listBox.y + listBox.height - fieldBox.y),
              Math.abs(listBox.y - fieldBox.y - fieldBox.height),
            );
          })
          .toBeLessThanOrEqual(8);
        await page.screenshot({
          path: `test-results/launch-list-${name}-${viewport.width}x${viewport.height}.png`,
          animations: "disabled",
        });
        await field.press("Escape");
        await expect(list).toHaveCount(0);
        await expect(page.getByRole("dialog")).toBeVisible();
      }
      const field = page.getByLabel("Zugang", { exact: true });
      await field.scrollIntoViewIfNeeded();
      await field.click();
      await page.getByRole("option", { name: "Profil 2", exact: true }).click();
      await expect(field).toHaveValue("account-2");
      await field.press("ArrowDown");
      await field.press("ArrowDown");
      await field.press("Enter");
      await expect(field).toHaveValue("account-3");
      await field.click();
      // On short viewports the menu can cover the name field. Click the dialog
      // padding to exercise outside dismissal without targeting an obscured input.
      const dialogBox = await page.getByRole("dialog").boundingBox();
      await page.mouse.click(dialogBox.x + 4, dialogBox.y + dialogBox.height / 2);
      await expect(page.getByRole("listbox")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
