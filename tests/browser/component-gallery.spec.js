import { test, expect } from "../helpers/browser-test.js";

// Settings › Operations › Development › Components (docs/ui-guide.md#component-gallery):
// every section renders with the real components and nothing overflows the viewport.
const sections = {
  "de-DE": [
    "Buttons und Icons",
    "Gruppen, Karten und Zeilen",
    "Bedienelemente",
    "Auswahl und Tabs",
    "Status und Rückmeldung",
    "Dialoge und Sheets",
    "Layout",
    "Speicherleiste",
  ],
  "en-GB": [
    "Buttons and icons",
    "Groups, cards and rows",
    "Controls",
    "Choices and tabs",
    "Status and feedback",
    "Dialogs and sheets",
    "Layout",
    "Save bar",
  ],
};

async function expectNoOverflow(page) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const page = document.scrollingElement.scrollWidth - width;
    const wide = [...document.querySelectorAll(".gallery-section, .gallery-specimen")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.right > width + 1 || box.left < -1;
      })
      .map(
        (element) => element.id || element.querySelector(".gallery-caption")?.textContent,
      );
    return { page, wide };
  });
  expect(overflow).toEqual({ page: 0, wide: [] });
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
])
  for (const locale of Object.keys(sections))
    test.describe(`${name} ${locale}`, () => {
      test.use({
        locale,
        viewport,
        ...(name === "phone" ? { hasTouch: true, isMobile: true } : {}),
      });

      test("the gallery renders every section without overflow", async ({ page }) => {
        await page.goto("/settings/components");
        const en = locale === "en-GB";
        await expect(
          page.getByRole("heading", {
            level: 1,
            name: en ? "Components" : "Komponenten",
          }),
        ).toBeVisible();
        for (const title of sections[locale])
          await expect(
            page.getByRole("heading", { level: 2, name: title }),
          ).toBeVisible();
        await expect(page.locator("[data-gallery-section]")).toHaveCount(
          sections[locale].length,
        );
        await expect(page.locator(".gallery-icons li").first()).toBeVisible();
        await expect(
          page.getByRole("tablist", { name: en ? "Sample tabs" : "Beispiel-Tabs" }),
        ).toBeVisible();
        await expect(
          page.getByRole("region", {
            name: en ? "Unsaved changes" : "Ungespeicherte Änderungen",
          }),
        ).toBeVisible();
        await expectNoOverflow(page);
        await page.screenshot({
          path: test.info().outputPath(`component-gallery-${name}-${locale}.png`),
          fullPage: true,
        });
      });
    });

test.describe("phone dialogs", () => {
  test.use({
    locale: "en-GB",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("the gallery's dialogs and sheets open and close on a phone", async ({ page }) => {
    await page.goto("/settings/components");
    for (const [opener, title] of [
      ["Open Modal with footer", "Modal with footer"],
      ["Open Sheet", "Sheet"],
      ["Open Unsaved changes sheet", "Save changes?"],
      ["Open Side panel", "Side panel"],
    ]) {
      await page.getByRole("button", { name: opener, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(391);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    // A row's ⋯ menu opens its items as a sheet on phones; Cancel returns focus.
    const more = page.getByRole("button", { name: "Actions for Sample" });
    await more.click();
    const sheet = page.getByRole("dialog", { name: "Sample" });
    await expect(sheet.getByText("A sheet on phones, a menu on desktop")).toBeVisible();
    await sheet.getByRole("menuitemradio", { name: "Option B" }).click();
    await expect(sheet).toBeHidden();
    await more.click();
    await expect(
      page.getByRole("dialog", { name: "Sample" }).getByRole("menuitemradio", {
        name: "Option B",
      }),
    ).toHaveAttribute("aria-checked", "true");
    await page
      .getByRole("dialog", { name: "Sample" })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(more).toBeFocused();
  });
});

test.describe("desktop row menu", () => {
  test.use({ locale: "en-GB" });

  test("the gallery's row menu opens as a popover with radio items", async ({ page }) => {
    await page.goto("/settings/components");
    const more = page.getByRole("button", { name: "Actions for Sample" });
    // The popover closes on scroll; the scroll event of bringing the button into view
    // arrives a frame later, so it must pass before the menu opens.
    await more.scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await more.click();
    const menu = page.getByRole("menu", { name: "Actions for Sample" });
    await expect(menu.getByRole("menuitemradio")).toHaveText(["Option A", "Option B"]);
    await expect(menu.getByRole("menuitem")).toHaveText(["Edit", "Delete"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
});

test("Settings › Operations › Development leads to the gallery", async ({ page }) => {
  await page.goto("/settings?tab=operations");
  await page.getByRole("link", { name: /^Komponenten/ }).click();
  await expect(page).toHaveURL(/\/settings\/components$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Komponenten" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zurück zu Betrieb" }).click();
  await expect(page).toHaveURL(/\/settings\?tab=operations$/);
});
