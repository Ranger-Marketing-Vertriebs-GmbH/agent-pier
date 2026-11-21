// AGENTPIER-455: the explorer and editor polish from feature test W7, at desktop and
// phone width.
import { test, expect } from "../helpers/browser-test.js";
import { actionsFixture, trashEntry } from "../helpers/file-actions-browser.js";
import {
  explorerContext,
  explorerEntry,
  explorerListing,
  selectEnglish,
} from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

const viewports = [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
];

for (const [label, viewport] of viewports) {
  test(`Trash rows put the box beside the path and name each entry apart (${label})`, async ({
    page,
  }) => {
    const f = await actionsFixture(page);
    f.trash = [
      trashEntry("one", { originalPath: "/home/test/a/note.txt" }),
      trashEntry("two", { originalPath: "/home/test/b/note.txt" }),
    ];
    await page.setViewportSize(viewport);
    await selectEnglish(page);
    await page.goto(baseURL + "/files?panel=trash");
    const first = page.getByRole("checkbox", {
      name: /^Select \/home\/test\/a\/note\.txt, deleted /,
    });
    const second = page.getByRole("checkbox", {
      name: /^Select \/home\/test\/b\/note\.txt, deleted /,
    });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    const box = await first.boundingBox();
    const path = await page
      .getByText("/home/test/a/note.txt", { exact: true })
      .boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(path.x);
    expect(Math.abs(box.y + box.height / 2 - (path.y + path.height / 2))).toBeLessThan(
      path.height,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });

  test(`a rename result names old and new path once each (${label})`, async ({
    page,
  }) => {
    const f = await actionsFixture(page);
    await page.routeWebSocket("**/api/**", (socket) => socket.close());
    f.jobs.set("job-r", {
      id: "job-r",
      scopeId: explorerContext.scopeId,
      kind: "rename",
      status: "completed",
      completedEntries: 1,
      totalEntries: 1,
      completedBytes: 0,
      totalBytes: null,
      conflict: null,
    });
    f.jobs.set("job-t", {
      id: "job-t",
      scopeId: explorerContext.scopeId,
      kind: "trash",
      status: "completed",
      completedEntries: 1,
      totalEntries: 1,
      completedBytes: 0,
      totalBytes: null,
      conflict: null,
    });
    await page.route(/\/api\/files\/jobs\/[^/]+\/entries/, (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-2);
      const row =
        id === "job-r"
          ? { source: "/home/test/old.txt", path: "/home/test/new.txt" }
          : { source: "/home/test/gone.txt", path: "/home/test/gone.txt" };
      return route.fulfill({
        json: { entries: [{ id: "0", status: "completed", ...row }], nextCursor: null },
      });
    });
    await page.setViewportSize(viewport);
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    await page.getByRole("button", { name: /^Activity/ }).click();
    const jobs = page.getByRole("region", { name: "File jobs", exact: true });
    for (const button of await jobs
      .getByRole("button", { name: "Load entry results", exact: true })
      .all())
      await button.click();
    await expect(jobs.getByText("/home/test/old.txt → /home/test/new.txt")).toBeVisible();
    await expect(jobs.getByText("/home/test/gone.txt", { exact: true })).toBeVisible();
    await expect(jobs).not.toContainText("gone.txt → ");
    // No "0 of unknown bytes" for jobs without byte counts; singular counts.
    await expect(jobs).not.toContainText("unknown bytes");
    await expect(jobs).toContainText("1 of 1 entry completed");
  });

  test(`the tree opens down to the current folder and the upload pickers speak English (${label})`, async ({
    page,
  }) => {
    await actionsFixture(page);
    await page.route(/\/api\/files\/entries\?/, (route) => {
      const path = new URL(route.request().url()).searchParams.get("path");
      const children = {
        "/": [explorerEntry("home", "directory", "/")],
        "/home": [explorerEntry("test", "directory", "/home")],
      }[path];
      return children
        ? route.fulfill({ json: explorerListing(path, children) })
        : route.fallback();
    });
    await page.setViewportSize(viewport);
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    if (label === "phone")
      await page
        .getByRole("button", { name: "Open directory tree", exact: true })
        .click();
    const tree = page.getByRole("navigation", { name: "Directory tree", exact: true });
    await expect(tree.getByRole("button", { name: "Collapse home" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(tree.locator('[aria-current="location"]')).toHaveText("test");
    if (label === "phone")
      await page
        .getByRole("button", { name: "Close directory tree", exact: true })
        .click();
    const crumbs = page.getByRole("navigation", { name: "Path segments", exact: true });
    await expect(crumbs.locator('[aria-current="location"]')).toBeInViewport();
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const uploads = page.getByRole("region", { name: "Uploads" });
    await expect(uploads.getByText("Upload files", { exact: true })).toBeVisible();
    await expect(uploads.getByText("Upload folder", { exact: true })).toBeVisible();
    // The browser's own "Choose files" control stays hidden behind the buttons.
    for (const input of await uploads.locator('input[type="file"]').all())
      await expect(input).toHaveClass(/visually-hidden/);
    await expect(uploads).not.toContainText(/No file chosen|Keine ausgewählt/);
  });

  test(`a read-only folder offers no Upload (${label})`, async ({ page }) => {
    await actionsFixture(page);
    await page.route("**/api/files/context", (route) =>
      route.fulfill({ json: { ...explorerContext, readOnly: true } }),
    );
    await page.setViewportSize(viewport);
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    await expect(page.getByRole("button", { name: /^Activity/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload", exact: true })).toHaveCount(
      0,
    );
  });

  test(`Download as ZIP starts the download, named after the selection (${label})`, async ({
    page,
  }) => {
    const f = await actionsFixture(page);
    await page.routeWebSocket("**/api/**", (socket) => socket.close());
    f.onStart = (body, job) => {
      Object.assign(job, {
        status: "completed",
        artifactReady: true,
        archiveOutput: "download",
      });
    };
    await page.setViewportSize(viewport);
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    await page.getByRole("checkbox", { name: "Select docs", exact: true }).check();
    await page
      .getByRole("group", { name: "Selected file actions", exact: true })
      .getByRole("button", { name: "More actions", exact: true })
      .click();
    await page
      .getByRole("menu", { name: "More actions", exact: true })
      .getByRole("menuitem", { name: "Download as ZIP", exact: true })
      .click();
    const download = page.waitForEvent("download");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
    // The browser fetches the job's artifact by itself; the server names it after the
    // operation's name (tests/integration/file-zip.test.js).
    expect((await download).url()).toMatch(/\/api\/files\/jobs\/job-1\/download$/);
    const start = f.requests.find((request) => request.body?.kind === "archive");
    expect(start.body).toMatchObject({ name: "docs.zip", target: null });
  });
}
