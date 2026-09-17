import {
  openExplorerDisclosure,
  openFileDetails,
} from "../helpers/file-explorer-layout.js";
import { test, expect } from "@playwright/test";
import { fixture } from "../helpers/repository-browser.js";
import { baseURL } from "../helpers/browser.js";
import {
  explorerContext,
  explorerEntry as entry,
  explorerFixture,
  explorerListing as listing,
} from "../helpers/file-explorer-browser.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a settled listing cannot restore the previous path", async ({ page }) => {
  await explorerFixture(page);
  const requested = [];
  const next = deferred();
  await page.route("**/api/files/entries**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    requested.push(path);
    if (path === "/b") await next.promise;
    await route.fulfill({ json: listing(path) }).catch(() => {});
  });

  await page.goto(baseURL + "/files?path=%2Fa");
  await expect(page.getByText("Dieser Ordner ist leer.")).toBeVisible();
  await openExplorerDisclosure(page, ".explorer-path-options");
  await page.getByRole("textbox", { name: "Pfad" }).fill("/b");
  await page.getByRole("button", { name: "Öffnen", exact: true }).click();
  await expect.poll(() => requested).toContain("/b");
  next.resolve();

  await expect(page.getByRole("textbox", { name: "Pfad" })).toHaveValue("/b");
  await expect(page).toHaveURL(/path=%2Fb$/);
  expect(requested).toEqual(["/a", "/b"]);
});

test("favorite removals serialize against the latest returned list", async ({ page }) => {
  await explorerFixture(page);
  let preferences = {
    favorites: [
      { id: "a", name: "A", path: "/a" },
      { id: "b", name: "B", path: "/b" },
    ],
    showHidden: false,
  };
  const first = deferred();
  const patches = [];
  await page.route("**/api/files/preferences", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: preferences });
    const body = route.request().postDataJSON();
    patches.push(body);
    if (patches.length === 1) await first.promise;
    preferences = { ...preferences, ...body };
    return route.fulfill({ json: preferences });
  });

  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest");
  await page.getByRole("button", { name: "Favorit A entfernen" }).click();
  await expect.poll(() => patches.length).toBe(1);
  await page.getByRole("button", { name: "Favorit B entfernen" }).click();
  first.resolve();

  await expect.poll(() => patches.length).toBe(2);
  expect(patches.map((patch) => patch.favorites.map((item) => item.id))).toEqual([
    ["b"],
    [],
  ]);
  await expect(page.getByRole("button", { name: /Favorit [AB] entfernen/ })).toHaveCount(
    0,
  );
});

test("hidden changes remain immediate while preference writes serialize", async ({
  page,
}) => {
  await explorerFixture(page);
  let preferences = { favorites: [], showHidden: false };
  const first = deferred();
  const patches = [];
  await page.route("**/api/files/preferences", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: preferences });
    const body = route.request().postDataJSON();
    patches.push(body);
    if (patches.length === 1) await first.promise;
    preferences = { ...preferences, ...body };
    return route.fulfill({ json: preferences });
  });

  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest");
  await openExplorerDisclosure(page, ".explorer-view-disclosure");
  const hidden = page.getByLabel("Versteckte Dateien anzeigen");
  await hidden.check();
  await expect(page).toHaveURL(/hidden=1/);
  await expect.poll(() => patches.length).toBe(1);
  await hidden.uncheck();
  await expect(page).toHaveURL(/hidden=0/);
  first.resolve();

  await expect.poll(() => patches.length).toBe(2);
  expect(patches).toEqual([{ showHidden: true }, { showHidden: false }]);
  await expect(hidden).not.toBeChecked();
});

test("a scope replacement rejects stale preferences and listing snapshots", async ({
  page,
}) => {
  const { state } = await fixture(page);
  const session = {
    id: "async-scope",
    name: "Async scope",
    tool: "shell",
    cwd: "/project/a",
    status: "running",
    accountId: "local-shell",
  };
  state.sessions.push(session);
  const patch = deferred();
  const patchStarted = deferred();
  const entryRequests = [];
  await page.route("**/api/sessions/async-scope/files/explorer/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const rootName = session.cwd.split("/").at(-1);
    if (url.pathname === "/api/sessions/async-scope/files/explorer/jobs")
      return route.fulfill({ json: { jobs: [], nextCursor: null } });
    if (url.pathname.endsWith("/context"))
      return route.fulfill({
        json: {
          ...explorerContext,
          scopeId: `f1:${rootName}`,
          kind: "project",
          root: session.cwd,
        },
      });
    if (url.pathname.endsWith("/preferences")) {
      if (request.method() === "PATCH") {
        patchStarted.resolve();
        await patch.promise;
        return route.fulfill({
          json: {
            favorites: [{ id: "a", name: "A", path: "" }],
            showHidden: false,
          },
        });
      }
      return route.fulfill({
        json: {
          favorites: [{ id: rootName, name: rootName.toUpperCase(), path: "" }],
          showHidden: false,
        },
      });
    }
    if (url.pathname.endsWith("/entries")) {
      const query = Object.fromEntries(url.searchParams);
      entryRequests.push({ root: session.cwd, query });
      return route.fulfill({
        json: listing("", [], { snapshotId: `snapshot-${rootName}`, parent: null }),
      });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected route" } });
  });

  await page.goto(baseURL + "/sessions/async-scope/files");
  await openExplorerDisclosure(page, ".explorer-view-disclosure");
  await page
    .getByRole("button", { name: "Aktuellen Ordner aus Favoriten entfernen" })
    .click();
  await patchStarted.promise;
  await page.getByRole("button", { name: "Ordnerbaum öffnen", exact: true }).click();
  session.cwd = "/project/b";
  await expect(page.getByRole("button", { name: "B", exact: true })).toBeVisible({
    timeout: 7000,
  });
  patch.resolve();

  await expect(page.getByRole("button", { name: "B", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "A", exact: true })).toHaveCount(0);
  const replacement = entryRequests.find((item) => item.root === "/project/b");
  expect(replacement.query.snapshot).toBeUndefined();
});

test("an obsolete link open cannot replace the current selection", async ({ page }) => {
  await explorerFixture(page);
  const directoryProbe = deferred();
  const directoryStarted = deferred();
  const fallbackPreview = deferred();
  const fallbackStarted = deferred();
  let probeMode = "directory";
  await page.route("**/api/files/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname.endsWith("/entries") &&
      url.searchParams.get("path") === "/home/test/linked-docs"
    ) {
      if (probeMode === "directory") {
        directoryStarted.resolve();
        await directoryProbe.promise;
        return route.fulfill({ json: listing("/home/test/linked-docs") }).catch(() => {});
      }
      return route.fulfill({
        status: 400,
        json: { error: "Dateioperation fehlgeschlagen.", code: "FILE_NOT_DIRECTORY" },
      });
    }
    if (
      probeMode === "preview" &&
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "/home/test/linked-docs"
    ) {
      fallbackStarted.resolve();
      await fallbackPreview.promise;
      return route
        .fulfill({ json: { type: "text", text: "obsolete link" } })
        .catch(() => {});
    }
    return route.fallback();
  });

  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest");
  await page.getByRole("button", { name: "linked-docs", exact: true }).click();
  await openFileDetails(page);
  await page.getByRole("button", { name: "Verknüpfungsziel öffnen" }).click();
  await directoryStarted.promise;
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  directoryProbe.resolve();
  await expect(page).toHaveURL(/file=%2Fhome%2Ftest%2Freadme.txt$/);
  await expect(page.locator(".file-preview pre")).toHaveText("Hello explorer");

  probeMode = "preview";
  await page.getByRole("button", { name: "linked-docs", exact: true }).click();
  await openFileDetails(page);
  await page.getByRole("button", { name: "Verknüpfungsziel öffnen" }).click();
  await fallbackStarted.promise;
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  fallbackPreview.resolve();
  await expect(page).toHaveURL(/file=%2Fhome%2Ftest%2Freadme.txt$/);
  await expect(page.locator(".file-preview pre")).toHaveText("Hello explorer");
});

test("clearing a pending selection clears property loading", async ({ page }) => {
  await explorerFixture(page);
  const metadata = deferred();
  const metadataStarted = deferred();
  await page.route("**/api/files/metadata**", async (route) => {
    metadataStarted.resolve();
    await metadata.promise;
    return route.fulfill({ json: entry("readme.txt", "file") }).catch(() => {});
  });

  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest");
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await metadataStarted.promise;
  await expect(page.getByText("Dateieigenschaften werden geladen …")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Pfadsegmente" })
    .getByRole("button", { name: "/", exact: true })
    .click();

  await expect(page.locator(".file-properties")).toHaveCount(0);
  await expect(page.getByText("Dateieigenschaften werden geladen …")).toHaveCount(0);
  metadata.resolve();
});

test("tree paging discards a completion from an obsolete hidden view", async ({
  page,
}) => {
  await explorerFixture(page);
  const oldPage = deferred();
  const queries = [];
  await page.route("**/api/files/entries**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "/") return route.fallback();
    const query = Object.fromEntries(url.searchParams);
    queries.push(query);
    if (query.page === "2") {
      await oldPage.promise;
      return route
        .fulfill({
          json: listing("/", [entry("obsolete", "directory", "/")], {
            page: 2,
            snapshotId: "old-tree",
          }),
        })
        .catch(() => {});
    }
    const name = query.hidden === "1" ? "fresh-hidden" : "first";
    return route.fulfill({
      json: listing("/", [entry(name, "directory", "/")], {
        hasMore: query.hidden !== "1",
        snapshotId: query.hidden === "1" ? "new-tree" : "old-tree",
      }),
    });
  });

  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest");
  await page.getByRole("button", { name: "/ aufklappen" }).click();
  await page.getByRole("button", { name: "Weitere Ordner laden" }).click();
  await expect.poll(() => queries.some((query) => query.page === "2")).toBe(true);
  await openExplorerDisclosure(page, ".explorer-view-disclosure");
  await page.getByLabel("Versteckte Dateien anzeigen").check();
  await expect(
    page.getByRole("button", { name: "fresh-hidden", exact: true }),
  ).toBeVisible();
  oldPage.resolve();

  await expect(page.getByRole("button", { name: "obsolete", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(/abort/i)).toHaveCount(0);
});
