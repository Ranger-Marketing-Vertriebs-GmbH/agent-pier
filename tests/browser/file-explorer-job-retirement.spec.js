import { openExplorerPanel } from "../helpers/file-explorer-layout.js";
import { test, expect } from "@playwright/test";
import { jobsFixture } from "../helpers/file-jobs-browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

test("expired history work does not block current outcomes and later pages remain bounded", async ({
  page,
}, testInfo) => {
  const f = await jobsFixture(page);
  const old = f.addJob({ kind: "copy", status: "running" });
  const current = f.addJob({ kind: "move", status: "running" });
  for (let i = 2; i < 205; i++) f.addJob({ kind: "copy", status: "completed" });
  let expired = false,
    oldReads = 0;
  await page.route(/\/api\/files\/jobs(?:\?.*)?$/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const jobs = [...f.jobs.values()].filter((job) => !expired || job.id !== old.id);
    return route.fulfill({
      json: {
        jobs: jobs.slice(cursor ? 200 : 0, cursor ? 400 : 200),
        nextCursor: cursor ? null : "later",
      },
    });
  });
  await page.route(`**/api/files/jobs/${old.id}`, (route) => {
    oldReads++;
    return expired
      ? route.fulfill({ status: 404, json: { code: "FILE_NOT_FOUND" } })
      : route.fulfill({ json: old });
  });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await openExplorerPanel(page, "activity");
  await expect.poll(() => oldReads).toBeGreaterThan(0);
  expired = true;
  f.finish(current.id, [
    {
      id: "current",
      source: "/home/test/a.txt",
      path: "/home/test/docs/a.txt",
      status: "completed",
      outputPublished: true,
      sourceRemoved: true,
    },
  ]);
  const card = page.locator(`[data-job-id="${current.id}"]`);
  await expect(card.locator(".file-job-heading")).toContainText("Completed");
  await expect(card).toContainText("/home/test/docs/a.txt");
  const region = page.getByRole("region", { name: "File jobs", exact: true });
  await region.getByRole("button", { name: "Next jobs", exact: true }).click();
  await expect(region.locator(".file-job-list > li")).toHaveCount(4);
  await expect(page.locator(`[data-job-id="${current.id}"]`)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("bounded-job-history-en.png") });
  await region.getByRole("button", { name: "Previous jobs", exact: true }).click();
  await card.getByRole("button", { name: "Load entry results", exact: true }).click();
  await expect(card).toContainText("/home/test/docs/a.txt");
});
