import { test, expect } from "../helpers/browser-test.js";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { baseURL } from "../helpers/browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";

const href = (name) =>
  `/api/files/download?path=${new URLSearchParams({ path: `/home/test/${name}` }).toString().slice(5)}`;

for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`${label}: a single file offers a direct download in its menu and the selection menu`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await actionsFixture(page);
    await selectEnglish(page);
    await page.goto(baseURL + "/files");

    await page.getByRole("button", { name: "Actions for a.txt", exact: true }).click();
    const itemMenu = page.getByRole("menu", { name: "Actions for a.txt", exact: true });
    const link = itemMenu.getByRole("menuitem", { name: "Download", exact: true });
    await expect(link).toHaveAttribute("href", href("a.txt"));
    await expect(link).toHaveAttribute("download", "");
    await expect(
      itemMenu.getByRole("menuitem", { name: "Download as ZIP" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Actions for docs", exact: true }).click();
    const folderMenu = page.getByRole("menu", { name: "Actions for docs", exact: true });
    await expect(
      folderMenu.getByRole("menuitem", { name: "Download as ZIP" }),
    ).toBeVisible();
    await expect(
      folderMenu.getByRole("menuitem", { name: "Download", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
    const group = page.getByRole("group", { name: "Selected file actions", exact: true });
    await group.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "Download", exact: true }),
    ).toHaveAttribute("href", href("a.txt"));
    await page.keyboard.press("Escape");

    await page.getByRole("checkbox", { name: "Select b.txt", exact: true }).check();
    await group.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "Download", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Download as ZIP" })).toBeVisible();
  });
}
