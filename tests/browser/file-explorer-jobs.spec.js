import { test, expect } from "@playwright/test";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { explorerContext, selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";
import { jobsFixture } from "../helpers/file-jobs-browser.js";

test("explicit operation history reaches an interrupted job beyond the first200 after reload", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  await page.routeWebSocket("**/api/**", (socket) => socket.close());
  const jobs = Array.from({ length: 201 }, (_, index) => ({
    id: `history-${index}`,
    scopeId: explorerContext.scopeId,
    kind: "extract",
    status: index === 200 ? "interrupted" : "completed",
    completedEntries: 0,
    totalEntries: null,
    completedBytes: 0,
    totalBytes: null,
    conflict: null,
  }));
  for (const job of jobs) {
    f.jobs.set(job.id, job);
    f.rows.set(job.id, []);
  }
  await page.route("**/api/files/jobs?*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      json: {
        jobs: cursor ? jobs.slice(200) : jobs.slice(0, 200),
        nextCursor: cursor ? null : "next-200",
      },
    });
  });
  await page.route("**/api/files/jobs", (route) =>
    route.fulfill({ json: { jobs: jobs.slice(0, 200), nextCursor: "next-200" } }),
  );
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const region = page.getByRole("region", { name: "File jobs", exact: true });
  await region.getByRole("button", { name: "Next jobs", exact: true }).click();
  await expect(region).toContainText("Interrupted");
  expect(f.requests.filter((request) => request.method === "POST")).toEqual([]);
});

test("history loads all mutable result pages and preserves completed and failed outcomes", async ({
  page,
}) => {
  const f = await jobsFixture(page);
  const rows = Array.from({ length: 201 }, (_, index) => ({
    id: String(index),
    source: "/home/test/input.zip",
    path: `/home/test/docs/result-${index}`,
    name: `result-${index}`,
    type: "file",
    status: index < 200 ? "completed" : "failed",
    outputPublished: index < 200,
    ...(index === 200 ? { issue: { code: "FILE_ACCESS_DENIED" } } : {}),
  }));
  const job = f.addJob(
    {
      status: "partially_completed",
      completedEntries: 200,
      totalEntries: 201,
      completedBytes: 100,
      totalBytes: 101,
    },
    rows,
  );
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const card = page.locator(`[data-job-id="${job.id}"]`);
  await card.getByRole("button", { name: "Load entry results" }).click();
  await card.getByRole("button", { name: "Load next entry page" }).click();
  await expect(card).toContainText("result-200");
  await expect(card).toContainText("Completed entries (200)");
  const completed = card.getByRole("list", { name: "Completed entries", exact: true });
  await completed.focus();
  await completed.press("End");
  await expect
    .poll(() => completed.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(card).toContainText("Unfinished entries (1)");
  await expect(card).toContainText("You do not have permission");
  expect(f.entryPages.some((item) => item.cursor === "entries-200")).toBe(true);
});

test("explicit retry reviews every server page and preserves its request after response loss and reopening", async ({
  page,
}) => {
  const f = await jobsFixture(page),
    job = f.addJob({ status: "partially_completed", completedEntries: 1 });
  const attempts = [],
    reference = `r1:${"a".repeat(64)}`;
  let child;
  await page.route(/\/api\/files\/jobs\/[^/]+\/retry(?:\?.*)?$/, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === "GET") {
      const offset = url.searchParams.has("cursor") ? 200 : 0;
      return route.fulfill({
        json: {
          reference,
          totalEntries: 201,
          entries: Array.from({ length: offset ? 1 : 200 }, (_, index) => ({
            id: String(index + offset),
            path: `/home/test/docs/retry-${index + offset}`,
          })),
          nextCursor: offset ? null : "retry-200",
        },
      });
    }
    attempts.push(request.postDataJSON());
    if (!child) {
      child = f.addJob({ id: "retried-child", status: "completed" });
      return route.abort("failed");
    }
    return route.fulfill({ status: 202, json: child });
  });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const card = page.locator(`[data-job-id="${job.id}"]`);
  await card.getByRole("button", { name: "Review retry" }).click();
  let dialog = page.getByRole("dialog", { name: "Retry unfinished entries" });
  await expect(dialog).toContainText("201 eligible entries");
  await dialog.getByRole("button", { name: "Show more entry results" }).click();
  await expect(dialog).toContainText("retry-200");
  await dialog.getByRole("button", { name: "Confirm new retry" }).click();
  await expect(dialog).toContainText("same request");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "docs", exact: true }).click();
  await card.getByRole("button", { name: "Review retry" }).click();
  dialog = page.getByRole("dialog", { name: "Retry unfinished entries" });
  await dialog.getByRole("button", { name: "Confirm new retry" }).click();
  await expect(dialog).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(Object.keys(attempts[0]).sort()).toEqual(["reference", "requestId"]);
  expect(job.status).toBe("partially_completed");
  expect(f.jobs.size).toBe(2);
});

test("archive request uncertainty survives closing its dialog and same-scope folder navigation", async ({
  page,
}) => {
  const f = await jobsFixture(page),
    attempts = [];
  let job;
  await page.route("**/api/files/operations", async (route) => {
    attempts.push(route.request().postDataJSON());
    if (!job) {
      job = f.addJob({ kind: "archive", status: "running" });
      return route.abort("failed");
    }
    return route.fulfill({ status: 202, json: job });
  });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "Create ZIP", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("same request");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("button", { name: "docs", exact: true }).click();
  await page.getByRole("button", { name: "Check existing request", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check existing request", exact: true }),
  ).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]).toMatchObject({
    kind: "archive",
    target: "/home/test",
    options: { output: "file" },
  });
  await expect(page.locator(`[data-job-id="${job.id}"]`)).toContainText(
    "Preparing archive",
  );
});

test("German extraction errors and unknown totals remain explicit on desktop and 390px", async ({
  page,
}, testInfo) => {
  const f = await jobsFixture(page);
  f.onStart = (body, job) => {
    expect(body).toMatchObject({
      kind: "extract",
      target: "/home/test",
      name: null,
      options: {},
    });
    Object.assign(job, {
      status: "failed",
      totalEntries: null,
      totalBytes: null,
      issue: { code: "FILE_EXTRACT_UNSUPPORTED", args: {} },
    });
  };
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "input.zip auswählen", exact: true }).check();
  await page.getByRole("button", { name: "Hier entpacken", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Bestätigen", exact: true })
    .click();
  const region = page.getByRole("region", { name: "Dateiaufträge", exact: true });
  await expect(region).toContainText("unbekannt");
  await expect(region).toContainText("APFS");
  await expect(region).toContainText("ext4");
  await page.screenshot({
    path: testInfo.outputPath("jobs-desktop-de.png"),
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
  const retryButton = region.getByRole("button", {
    name: "Wiederholung prüfen",
    exact: true,
  });
  await retryButton.scrollIntoViewIfNeeded();
  await expect(retryButton).toBeInViewport();
  await expect(
    region.getByRole("button", { name: "Einzelergebnisse laden", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("jobs-mobile-de.png"),
    fullPage: true,
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  expect(
    f.requests.filter((item) => item.suffix.endsWith("/retry") && item.method === "POST"),
  ).toHaveLength(0);
});
