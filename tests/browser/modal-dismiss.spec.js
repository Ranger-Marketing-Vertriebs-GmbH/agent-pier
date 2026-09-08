import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./ssh-fixture.js";

async function openDraft(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByLabel("Name", { exact: true });
  await name.fill("Unsaved deployment key");
  return { dialog, name };
}

for (const gesture of ["backdrop click", "text selection dragged outside"]) {
  test(`modal retains its draft after ${gesture}`, async ({ page }) => {
    const { dialog, name } = await openDraft(page);
    const box = await dialog.boundingBox();
    const outside = { x: box.x - 20, y: box.y + box.height / 2 };
    if (gesture === "backdrop click") {
      await page.mouse.click(outside.x, outside.y);
    } else {
      const input = await name.boundingBox();
      await page.mouse.move(input.x + 100, input.y + input.height / 2);
      await page.mouse.down();
      await page.mouse.move(outside.x, outside.y, { steps: 12 });
      await page.mouse.up();
    }
    await expect(dialog).toBeVisible();
    await expect(name).toHaveValue("Unsaved deployment key");
  });
}

test("modal still closes with Cancel, its close button, and Escape", async ({ page }) => {
  const { dialog } = await openDraft(page);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("busy modal keeps its draft when Escape is pressed", async ({ page }) => {
  const { dialog, name } = await openDraft(page);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/ssh-keys", async (route) => {
    await pending;
    await route.fulfill({ status: 409, json: { error: "Fixture conflict" } });
  });
  try {
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(name).toHaveValue("Unsaved deployment key");
  } finally {
    release();
  }
  await expect(dialog.getByRole("alert")).toContainText("Fixture conflict");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
