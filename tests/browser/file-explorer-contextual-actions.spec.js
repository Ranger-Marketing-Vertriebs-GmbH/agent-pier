import { test, expect } from "@playwright/test";
import { actionEntry, actionsFixture } from "../helpers/file-actions-browser.js";
import { baseURL } from "../helpers/browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";

test("file actions stay contextual and keep creation and advanced commands in menus", async ({
  page,
}) => {
  await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");

  const actions = page.getByRole("region", { name: "File actions", exact: true });
  await expect(actions.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  await expect(actions.getByRole("button", { name: "Rename", exact: true })).toHaveCount(
    0,
  );
  await expect(actions.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  await expect(
    actions.getByRole("button", { name: "New file", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await expect(
    page
      .getByRole("menu", { name: "More actions", exact: true })
      .getByRole("menuitem", { name: "Create ZIP", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "New", exact: true }).click();
  const newMenu = page.getByRole("menu", { name: "New", exact: true });
  await expect(newMenu.getByRole("menuitem", { name: "New file" })).toBeVisible();
  await expect(newMenu.getByRole("menuitem", { name: "New folder" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
  const selectedActions = page.getByRole("group", {
    name: "Selected file actions",
    exact: true,
  });
  await expect(
    selectedActions.getByRole("button", { name: "Copy", exact: true }),
  ).toBeVisible();
  await expect(
    selectedActions.getByRole("button", { name: "Rename", exact: true }),
  ).toBeVisible();
  await expect(
    selectedActions.getByRole("button", { name: "Move to Trash" }),
  ).toBeVisible();
  await expect(
    selectedActions.getByRole("button", { name: "Create ZIP", exact: true }),
  ).toHaveCount(0);
  await selectedActions
    .getByRole("button", { name: "More actions", exact: true })
    .click();
  await expect(page.getByRole("menuitem", { name: "Create ZIP" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Actions for a.txt", exact: true }).click();
  const itemMenu = page.getByRole("menu", { name: "Actions for a.txt", exact: true });
  await expect(itemMenu.getByRole("menuitem", { name: "Properties" })).toBeVisible();
  await expect(itemMenu.getByRole("menuitem", { name: "Create ZIP" })).toBeVisible();
});

test("narrow desktop list rows keep compact metadata and actions inside the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "a.txt", exact: true }).click();

  const row = page.getByRole("button", { name: "a.txt", exact: true }).locator("..");
  await expect(row.locator(".explorer-entry-mobile-meta")).toBeVisible();
  const menu = row.getByRole("button", { name: "Actions for a.txt", exact: true });
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((element) => getComputedStyle(element).gridColumnStart),
  ).toBe("3");
  expect(
    await row
      .locator(".explorer-entry-mobile-meta")
      .evaluate((element) => [
        getComputedStyle(element).gridColumnStart,
        getComputedStyle(element).gridRowStart,
      ]),
  ).toEqual(["2", "2"]);
  expect(
    await row.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const [rowBox, menuBox] = await Promise.all([row.boundingBox(), menu.boundingBox()]);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
});

test("short touch viewports keep the complete item menu reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 360 });
  await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "Actions for a.txt", exact: true }).click();

  const menu = page.getByRole("menu", { name: "Actions for a.txt", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Cancel", exact: true })).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(352);
});

test("a ZIP menu near the bottom scrolls within a portrait viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await actionsFixture(page);
  fixture.files.push(actionEntry("input.zip"));
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "Actions for input.zip", exact: true }).click();

  const menu = page.getByRole("menu", { name: "Actions for input.zip", exact: true });
  await expect(
    menu.getByRole("menuitem", { name: "Extract to folder …", exact: true }),
  ).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Cancel", exact: true })).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(836);
});
