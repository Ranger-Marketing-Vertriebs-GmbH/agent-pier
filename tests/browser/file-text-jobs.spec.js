import { test, expect } from "@playwright/test";
import { jobsFixture } from "../helpers/file-jobs-browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

test("English text-save history exposes its outcome without a generic retry capability", async ({
  page,
}, testInfo) => {
  const f = await jobsFixture(page);
  const failed = f.addJob({
    kind: "text_save",
    status: "failed",
    issue: { code: "FILE_CONFLICT_CHANGED", args: {} },
  });
  const completed = f.addJob({
    kind: "text_save",
    status: "completed",
    completedEntries: 1,
    totalEntries: 1,
  });
  const ordinary = f.addJob({ kind: "copy", status: "failed" });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const failedCard = page.locator(`[data-job-id="${failed.id}"]`);
  await expect(failedCard).toContainText("Save text");
  await expect(failedCard).toContainText("Failed");
  await expect(failedCard.getByRole("button", { name: "Review retry" })).toHaveCount(0);
  await expect(page.locator(`[data-job-id="${completed.id}"]`)).toContainText(
    "Completed",
  );
  await expect(
    page
      .locator(`[data-job-id="${ordinary.id}"]`)
      .getByRole("button", { name: "Review retry" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("text-save-english-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(page.locator(".nav-backdrop")).not.toBeVisible();
  await failedCard.scrollIntoViewIfNeeded();
  await expect(failedCard).toBeInViewport();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("text-save-english-mobile.png"),
    fullPage: true,
  });
  expect(f.requests.filter((request) => request.suffix.endsWith("/retry"))).toHaveLength(
    0,
  );
});
