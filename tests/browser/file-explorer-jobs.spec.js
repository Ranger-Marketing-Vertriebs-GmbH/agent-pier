import { openExplorerPanel } from "../helpers/file-explorer-layout.js";
import { test, expect } from "@playwright/test";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { explorerContext, selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";
import { jobsFixture } from "../helpers/file-jobs-browser.js";

test("later live history reaches fresh conflicts and terminal states without loading entry results", async ({
  page,
}) => {
  const f = await jobsFixture(page);
  const first = f.addJob({ kind: "create_directory", status: "running" });
  for (let i = 1; i < 200; i++) f.addJob({ status: "completed" });
  const later = f.addJob({ status: "running" });
  const list = async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      json: {
        jobs: [...f.jobs.values()].slice(cursor ? 200 : 0, cursor ? 400 : 200),
        nextCursor: cursor ? null : "page-200",
      },
    });
  };
  await page.route(/\/api\/files\/jobs(?:\?.*)?$/, list);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await openExplorerPanel(page, "activity");
  const region = page.getByRole("region", { name: "File jobs", exact: true });
  await region.getByRole("button", { name: "Next jobs", exact: true }).click();
  later.status = "waiting_for_conflict";
  later.conflict = {
    id: "later-conflict",
    type: "name",
    source: "/home/test/input.zip",
    target: "/home/test/docs/new.txt",
    sourceType: "file",
    targetType: "file",
    choices: ["replace", "skip", "keep_both", "cancel"],
  };
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("new.txt");
  await dialog.getByRole("button", { name: "Skip", exact: true }).click();
  later.status = "completed";
  later.conflict = null;
  await expect(
    page.locator(`[data-job-id="${later.id}"] .file-job-heading`),
  ).toContainText("Completed");
  await region.getByRole("button", { name: "Previous jobs", exact: true }).click();
  first.status = "completed";
  await expect(
    page.locator(`[data-job-id="${first.id}"] .file-job-heading`),
  ).toContainText("Completed");
  expect(f.requests.some((item) => item.suffix === `/jobs/${later.id}`)).toBe(true);
});

test("upload-owned directory jobs stay in upload recovery while standalone directories keep generic controls", async ({
  page,
}) => {
  const f = await jobsFixture(page);
  const owned = f.addJob({
    kind: "create_directory",
    status: "failed",
    uploadGroupId: "group-owner",
  });
  const standalone = f.addJob({ kind: "create_directory", status: "failed" });
  f.addJob({
    kind: "create_directory",
    status: "waiting_for_conflict",
    uploadGroupId: "unselected-group",
    conflict: {
      id: "owned-conflict",
      type: "name",
      target: "/home/test/owned",
      choices: ["skip", "cancel"],
    },
  });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await openExplorerPanel(page, "activity");
  await expect(
    page
      .locator(`[data-job-id="${standalone.id}"]`)
      .getByRole("button", { name: "Review retry" }),
  ).toBeVisible();
  await expect(page.locator(`[data-job-id="${owned.id}"]`)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const language of ["en", "de"])
  test(`retry destinations and cancelled/interrupted partial outcomes remain explicit in ${language}`, async ({
    page,
  }, testInfo) => {
    const f = await jobsFixture(page);
    const job = f.addJob(
      { status: "partially_completed", completedEntries: 1, totalEntries: 4 },
      [
        {
          id: "done",
          source: "input.zip",
          path: "/home/test/docs/done.txt",
          status: "completed",
          outputPublished: true,
        },
        {
          id: "cancelled",
          source: "input.zip",
          path: "/home/test/docs/cancelled.txt",
          status: "cancelled",
        },
        {
          id: "interrupted",
          source: "input.zip",
          path: "/home/test/docs/interrupted.txt",
          status: "interrupted",
        },
        {
          id: "unknown",
          source: "input.zip",
          path: "/home/test/docs/unknown.txt",
          status: "unexpected",
        },
      ],
    );
    const restore = f.addJob({ kind: "restore", status: "failed" });
    const move = f.addJob({ kind: "move", status: "partially_completed" }, [
      {
        id: "published",
        source: "/home/test/a",
        path: "/home/test/docs/a",
        status: "interrupted",
        outputPublished: true,
        sourceRemoved: false,
      },
      {
        id: "uncertain",
        source: "/home/test/b",
        path: "/home/test/docs/b",
        status: "cancelled",
        sourceRemovalPending: true,
      },
    ]);
    await page.route(/\/api\/files\/jobs\/[^/]+\/retry(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          reference: `r1:${"b".repeat(64)}`,
          totalEntries: 1,
          nextCursor: null,
          entries: [
            {
              id: "0",
              source: "/home/test/original.txt",
              path: "/home/test/docs/chosen-restore.txt",
              type: "file",
            },
          ],
        },
      }),
    );
    if (language === "en") await selectEnglish(page);
    await page.goto(baseURL + "/files");
    await openExplorerPanel(page, "activity");
    const card = page.locator(`[data-job-id="${job.id}"]`);
    await card
      .getByRole("button", {
        name: language === "en" ? "Load entry results" : "Einzelergebnisse laden",
        exact: true,
      })
      .click();
    await expect(card).toContainText(language === "en" ? "Cancelled" : "Abgebrochen");
    await expect(card).toContainText(language === "en" ? "Interrupted" : "Unterbrochen");
    await expect(card).toContainText(
      language === "en" ? "Completion is unproven" : "Abschluss ist nicht nachgewiesen",
    );
    await page.screenshot({
      path: testInfo.outputPath(`outcomes-desktop-${language}.png`),
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
    await card.locator(".file-job-outcomes").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`outcomes-mobile-${language}.png`),
      fullPage: true,
    });
    const moved = page.locator(`[data-job-id="${move.id}"]`);
    await moved
      .getByRole("button", {
        name: language === "en" ? "Load entry results" : "Einzelergebnisse laden",
        exact: true,
      })
      .click();
    await expect(moved).toContainText(
      language === "en"
        ? "Destination published; source removal not completed"
        : "Ziel veröffentlicht; Quellentfernung nicht abgeschlossen",
    );
    await expect(moved).toContainText(
      language === "en" ? "Source removal is unproven" : "Quellentfernung ist ungeprüft",
    );
    await expect(moved.locator(".file-job-outcomes")).not.toContainText(
      language === "en" ? "Interrupted" : "Unterbrochen",
    );
    await page
      .locator(`[data-job-id="${restore.id}"]`)
      .getByRole("button", {
        name: language === "en" ? "Review retry" : "Wiederholung prüfen",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(
      language === "en"
        ? "Source: /home/test/original.txt"
        : "Quelle: /home/test/original.txt",
    );
    await expect(dialog).toContainText(
      language === "en"
        ? "Destination: /home/test/docs/chosen-restore.txt"
        : "Ziel: /home/test/docs/chosen-restore.txt",
    );
    const confirm = dialog.getByRole("button", {
      name: language === "en" ? "Confirm new retry" : "Neue Wiederholung bestätigen",
      exact: true,
    });
    await expect(confirm).toBeEnabled();
    await expect(confirm).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`retry-mobile-${language}.png`),
      fullPage: true,
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(() =>
        page
          .locator(".sidebar")
          .evaluate((element) => element.getBoundingClientRect().left),
      )
      .toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`retry-desktop-${language}.png`),
      fullPage: true,
    });
  });

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
  await openExplorerPanel(page, "activity");
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
  await openExplorerPanel(page, "activity");
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
  await openExplorerPanel(page, "activity");
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
  await openExplorerPanel(page, "activity");
  await page
    .locator(".file-primary-actions")
    .getByRole("button", { name: "More actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Create ZIP", exact: true }).click();
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
  await openExplorerPanel(page, "activity");
  await page.getByRole("checkbox", { name: "input.zip auswählen", exact: true }).check();
  await page
    .locator(".file-selection-actions")
    .getByRole("button", { name: "Weitere Aktionen", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Hier entpacken", exact: true }).click();
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
