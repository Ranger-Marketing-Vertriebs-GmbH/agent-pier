import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";

test("a small confirmation opens as a short bottom sheet on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pipelinesFixture(page);
  await openPipelines(page, "profiles/profile-one");
  await page.getByRole("button", { name: "Löschen: Planer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Aktion bestätigen" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  // Content-sized, far below the 82dvh sheet height, and anchored to the bottom edge.
  expect(box.height).toBeLessThan(844 * 0.5);
  expect(Math.round(box.y + box.height)).toBe(844);
  expect(Math.round(box.width)).toBe(390);
});
