import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  explorerFixture,
  explorerEntry,
  explorerContext,
  selectEnglish,
} from "../helpers/file-explorer-browser.js";

async function openDisclosure(page, selector) {
  const disclosure = page.locator(selector);
  if ((await disclosure.getAttribute("open")) === null)
    await disclosure.locator("> summary").click();
}

async function jobsFixture(page) {
  await explorerFixture(page);
  const jobs = new Map(),
    operations = [],
    unknown = [];
  let sequence = 0;
  await page.route("**/api/files/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const suffix = url.pathname.slice("/api/files".length);
    if (suffix === "/operations") {
      expect(request.headers()["x-file-scope"]).toBe(explorerContext.scopeId);
      const operation = request.postDataJSON();
      operations.push(operation);
      const job = {
        id: `job-${++sequence}`,
        kind: operation.kind,
        scopeId: explorerContext.scopeId,
        status: "running",
        completedEntries: 2,
        totalEntries: null,
        completedBytes: 0,
        totalBytes: null,
        issue: null,
        conflict: null,
      };
      jobs.set(job.id, job);
      return route.fulfill({ status: 202, json: job });
    }
    if (suffix === "/jobs")
      return route.fulfill({ json: { jobs: [], nextCursor: "oldest-history" } });
    if (suffix.startsWith("/jobs/")) {
      const [, , id, action] = suffix.split("/");
      const job = jobs.get(id);
      if (!job) {
        unknown.push(suffix);
        return route.fulfill({ status: 404, json: { code: "FILE_NOT_FOUND" } });
      }
      if (action === "cancel") {
        job.status = "cancelled";
        return route.fulfill({ json: job });
      }
      if (action === "entries")
        return route.fulfill({
          json: {
            entries: [
              {
                id: "result-1",
                ...explorerEntry("guide.txt", "file", "/home/test/docs"),
              },
            ],
            nextCursor: null,
          },
        });
      return route.fulfill({ json: job });
    }
    if (suffix === "/metadata" && url.searchParams.get("path") === "/home/test/docs")
      return route.fulfill({ json: explorerEntry("docs", "directory") });
    return route.fallback();
  });
  return { jobs, operations, unknown };
}

test("English recursive search shows partial results and opens their containing folder", async ({
  page,
  browserName,
}) => {
  const f = await jobsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest&sort=modifiedAt&hidden=0");
  await page.getByLabel("Filename search", { exact: true }).fill("guide");
  await openDisclosure(page, ".explorer-search-options");
  await page.getByLabel("Match case", { exact: true }).check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => f.operations.length).toBe(1);
  expect(f.operations[0]).toMatchObject({
    kind: "search",
    sources: ["/home/test"],
    target: null,
    name: null,
    options: { query: "guide", recursive: true, caseSensitive: true, hidden: false },
  });
  const job = f.jobs.get("job-1");
  job.status = "completed";
  job.issue = { code: "FILE_SEARCH_INCOMPLETE", args: { reason: "entries" } };
  const panel = page.getByRole("region", { name: "File jobs" });
  await expect(panel).toContainText("2 entries scanned");
  await expect(panel).toContainText("Entry limit reached");
  await expect(
    panel.getByRole("button", { name: "guide.txt", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/task-6-${browserName}-en-desktop-search.png`,
    fullPage: true,
  });
  await panel.getByRole("button", { name: "guide.txt", exact: true }).click();
  await expect(page).toHaveURL(/path=%2Fhome%2Ftest%2Fdocs/);
  await expect(page).toHaveURL(/file=%2Fhome%2Ftest%2Fdocs%2Fguide.txt/);
  await expect(page).toHaveURL(/sort=modifiedAt/);
  await openDisclosure(page, ".explorer-view-disclosure");
  await expect(page.getByLabel("Show hidden files")).not.toBeChecked();
  await expect(page.locator(".file-preview pre")).toHaveText("Hello explorer");
  expect(f.unknown).toEqual([]);
});

test("mobile requested size keeps unknown and partial values truthful and search can stop", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await jobsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest&file=%2Fhome%2Ftest%2Fdocs");
  const properties = page.getByRole("region", { name: "File properties" });
  await openDisclosure(page, ".file-details");
  await expect(properties).toContainText("Not calculated");
  await properties.getByRole("button", { name: "Calculate folder size" }).click();
  await expect.poll(() => f.jobs.size).toBe(1);
  expect(f.operations[0]).toMatchObject({
    kind: "size",
    sources: ["/home/test/docs"],
    options: {},
  });
  const job = f.jobs.get("job-1");
  job.completedBytes = 27;
  job.status = "completed";
  job.issue = { code: "FILE_SIZE_INCOMPLETE", args: { reason: "access" } };
  await expect(properties).toContainText("At least 27 bytes · incomplete");
  await expect(properties).toContainText("Some entries could not be accessed");
  await page.getByRole("button", { name: "Back to file list" }).click();
  await page.getByLabel("Filename search", { exact: true }).fill("txt");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const panel = page.getByRole("region", { name: "File jobs" });
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(panel).toContainText("Cancelled");
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/task-6-${browserName}-en-mobile-size.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(f.unknown).toEqual([]);
});

test("complete empty size is zero and failed size remains incomplete", async ({
  page,
}) => {
  const f = await jobsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest&file=%2Fhome%2Ftest%2Fdocs");
  const properties = page.getByRole("region", { name: "File properties" });
  await openDisclosure(page, ".file-details");
  await properties.getByRole("button", { name: "Calculate folder size" }).click();
  await expect.poll(() => f.jobs.size).toBe(1);
  Object.assign(f.jobs.get("job-1"), {
    status: "completed",
    completedBytes: 0,
    totalBytes: 0,
  });
  await expect(properties.getByText("0 bytes", { exact: true })).toBeVisible();
  await properties.getByRole("button", { name: "Calculate folder size" }).click();
  await expect.poll(() => f.jobs.size).toBe(2);
  Object.assign(f.jobs.get("job-2"), {
    status: "failed",
    completedBytes: 0,
    totalBytes: null,
    issue: { code: "FILE_IO_ERROR", args: {} },
  });
  await expect(properties).toContainText("At least 0 bytes · incomplete");
  await expect(properties.getByText("0 bytes", { exact: true })).toHaveCount(0);
});

test("project-root search selection preserves an empty parent and scope replacement clears old jobs", async ({
  page,
}) => {
  const { state } = await explorerFixture(page);
  const session = {
    id: "search-scope",
    name: "Search project",
    tool: "shell",
    cwd: "/fixture/one",
    status: "running",
    accountId: "local-shell",
  };
  state.sessions.push(session);
  const oldStarted = Promise.withResolvers(),
    oldResponse = Promise.withResolvers();
  let started = 0;
  const oldJob = {
    id: "old-job",
    kind: "search",
    scopeId: "f1:/fixture/one",
    status: "completed",
    completedEntries: 1,
    totalEntries: 1,
    completedBytes: 0,
    totalBytes: null,
    issue: null,
    conflict: null,
  };
  await page.route("**/api/sessions/search-scope/files/explorer/**", async (route) => {
    const url = new URL(route.request().url());
    const suffix = url.pathname.slice("/api/sessions/search-scope/files/explorer".length);
    if (suffix === "/context")
      return route.fulfill({
        json: {
          ...explorerContext,
          scopeId: `f1:${session.cwd}`,
          kind: "project",
          root: session.cwd,
        },
      });
    if (suffix === "/preferences")
      return route.fulfill({ json: { favorites: [], showHidden: false } });
    if (suffix === "/jobs")
      return route.fulfill({ json: { jobs: [], nextCursor: null } });
    if (suffix === "/operations") {
      expect(route.request().headers()["x-file-scope"]).toBe("f1:/fixture/one");
      if (++started === 2) {
        oldStarted.resolve();
        await oldResponse.promise;
      }
      return route.fulfill({ status: 202, json: oldJob });
    }
    if (suffix === "/jobs/old-job") return route.fulfill({ json: oldJob });
    if (suffix === "/jobs/old-job/entries")
      return route.fulfill({
        json: {
          entries: [
            {
              id: "found",
              ...explorerEntry("found.txt", "file", "", { path: "found.txt" }),
            },
          ],
          nextCursor: null,
        },
      });
    if (suffix === "/entries")
      return route.fulfill({
        json: {
          path: url.searchParams.get("path") || "",
          parent: null,
          entries: [],
          total: 0,
          page: 1,
          pageSize: 200,
          hasMore: false,
          snapshotId: "project-list",
        },
      });
    if (suffix === "/metadata")
      return route.fulfill({
        json: explorerEntry("found.txt", "file", "", { path: "found.txt" }),
      });
    if (suffix === "/preview")
      return route.fulfill({ json: { type: "text", text: "project root file" } });
    throw new Error(`Unexpected project search endpoint ${suffix}`);
  });
  await selectEnglish(page);
  await page.goto(baseURL + "/sessions/search-scope/files");
  await page.getByLabel("Filename search", { exact: true }).fill("found");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "found.txt", exact: true }).click();
  await openDisclosure(page, ".explorer-path-options");
  await expect(page.getByRole("textbox", { name: "Path", exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/\/files\?file=found.txt$/);
  await expect(page.locator(".file-preview pre")).toHaveText("project root file");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await oldStarted.promise;
  session.cwd = "/fixture/two";
  await expect(page).toHaveURL(/\/sessions\/search-scope\/files$/, { timeout: 7000 });
  await expect(page.getByRole("button", { name: "found.txt", exact: true })).toHaveCount(
    0,
  );
  oldResponse.resolve();
  await page.getByLabel("Filename search", { exact: true }).fill("new query");
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
  await expect(page.getByRole("region", { name: "File jobs" })).not.toContainText(
    "Completed",
  );
});
