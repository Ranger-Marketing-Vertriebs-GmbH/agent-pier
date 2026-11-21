import { openExplorerPanel } from "../helpers/file-explorer-layout.js";
import { test, expect } from "../helpers/browser-test.js";
import { jobsFixture } from "../helpers/file-jobs-browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

// Editor saves report in the editor (AGENTPIER-455): their text_save jobs, failed or
// completed, stay out of Activity and never raise "Needs attention" there.
test("English Activity leaves text saves to the editor and keeps other retries", async ({
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
  await openExplorerPanel(page, "activity");
  const ordinaryCard = page.locator(`[data-job-id="${ordinary.id}"]`);
  await expect(ordinaryCard.getByRole("button", { name: "Review retry" })).toBeVisible();
  await expect(page.locator(`[data-job-id="${failed.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-job-id="${completed.id}"]`)).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("text-save-english-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await ordinaryCard.scrollIntoViewIfNeeded();
  await expect(ordinaryCard).toBeInViewport();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  expect(f.requests.filter((request) => request.suffix.endsWith("/retry"))).toHaveLength(
    0,
  );
});
