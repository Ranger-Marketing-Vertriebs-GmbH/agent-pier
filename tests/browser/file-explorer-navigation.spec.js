import { test, expect } from "@playwright/test";
import { fixture } from "../helpers/repository-browser.js";
import { baseURL } from "../helpers/browser.js";
import {
  explorerContext as context,
  explorerEntry as entry,
  explorerFixture,
  selectEnglish,
} from "../helpers/file-explorer-browser.js";

test("English management opens Files and keeps its path after reload", async ({
  page,
  browserName,
}) => {
  const { requests, getPreferences } = await explorerFixture(page);
  await selectEnglish(page);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue("/home/test");
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest&hidden=1");
  await expect(page.getByRole("region", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue("/home/test");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue("/home/test");
  await page.getByRole("textbox", { name: "Path" }).fill("/home/test/docs");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue(
    "/home/test/docs",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue("/home/test");
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue(
    "/home/test/docs",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect(page.getByRole("region", { name: "File properties" })).toContainText(
    "/home/test/readme.txt",
  );
  await expect(page.locator(".file-preview pre")).toHaveText("Hello explorer");
  await page.getByRole("button", { name: "Add current folder to favorites" }).click();
  await expect(page.getByRole("button", { name: "test", exact: true })).toBeVisible();
  expect(getPreferences().favorites).toHaveLength(1);
  const patch = requests.find((item) => item.method === "PATCH");
  expect(patch.scope).toBe(context.scopeId);
  await page.getByLabel("Sort by").selectOption("modifiedAt");
  await page.getByLabel("Show hidden files").uncheck();
  await expect(page).toHaveURL(/sort=modifiedAt/);
  await expect(page).toHaveURL(/hidden=0/);
  await page.reload();
  await expect(page.getByLabel("Show hidden files")).not.toBeChecked();
  await page.goBack();
  await expect(page.getByLabel("Show hidden files")).toBeChecked();
  await page.goForward();
  await expect(page.getByLabel("Show hidden files")).not.toBeChecked();
  expect(
    requests.some(
      (item) =>
        item.path.endsWith("/entries") &&
        item.query.sort === "modifiedAt" &&
        item.query.hidden === "0",
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-en-desktop-1440x1000-files.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Remove current folder from favorites" })
    .click();
  await expect(page.getByRole("button", { name: "test", exact: true })).toHaveCount(0);
  expect(getPreferences().favorites).toHaveLength(0);
});

test("mobile explorer exposes the directory tree and symlink navigation", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { getPreferences } = await explorerFixture(page, {
    favorites: [{ id: "missing", name: "Fehlend", path: "/missing" }],
    showHidden: false,
  });
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest");
  await page.getByRole("button", { name: "Ordnerbaum öffnen" }).click();
  await expect(page.getByRole("dialog", { name: "Ordnerbaum" })).toBeVisible();
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-de-mobile-390x844-tree-vanished-favorite.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Favorit Fehlend entfernen" }).click();
  await expect(
    page.getByRole("button", { name: "Favorit Fehlend entfernen" }),
  ).toHaveCount(0);
  expect(getPreferences().favorites).toHaveLength(0);
  await page.getByRole("button", { name: "Ordnerbaum schließen" }).click();
  await page.getByRole("button", { name: "linked-docs", exact: true }).click();
  await expect(page.getByRole("region", { name: "Dateieigenschaften" })).toContainText(
    "docs",
  );
  await page.getByRole("button", { name: "Verknüpfungsziel öffnen" }).click();
  await expect(page.getByRole("textbox", { name: "Pfad" })).toHaveValue(
    "/home/test/linked-docs",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-de-mobile-390x844-files.png`,
    fullPage: true,
  });
});

test("invalid and expired listing pages require an explicit refresh", async ({
  page,
}) => {
  await explorerFixture(page, { favorites: [], showHidden: true });
  await page.goto(baseURL + "/files?page=wrong");
  await expect(page.getByRole("textbox", { name: "Pfad" })).toHaveValue("/home/test");
  await expect(page.getByLabel("Versteckte Dateien anzeigen")).toBeChecked();
  await expect(page.getByText("Diese Dateilistenseite ist ungültig.")).toBeVisible();
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest&page=wrong");
  await expect(page.getByText("Diese Dateilistenseite ist ungültig.")).toBeVisible();
  await page.getByRole("button", { name: "Dateiliste aktualisieren" }).last().click();
  await expect(page).toHaveURL(/path=%2Fhome%2Ftest&hidden=1$/);

  let expired = true;
  await page.route("**/api/files/entries**", async (route) => {
    if (expired) {
      expired = false;
      return route.fulfill({
        status: 409,
        json: {
          error: "Dateioperation fehlgeschlagen.",
          code: "FILE_SNAPSHOT_EXPIRED",
          args: {},
        },
      });
    }
    return route.fulfill({
      json: {
        path: "/home/test",
        parent: "/home",
        entries: [],
        total: 0,
        page: 1,
        pageSize: 200,
        hasMore: false,
        snapshotId: "fresh",
      },
    });
  });
  await page.reload();
  await expect(page.getByText("Diese Dateiliste ist abgelaufen.")).toBeVisible();
  await page.getByRole("button", { name: "Dateiliste aktualisieren" }).last().click();
  await expect(page.getByText("Dieser Ordner ist leer.")).toBeVisible();
});

test("pagination retains its snapshot and sorting starts a fresh listing", async ({
  page,
}) => {
  await explorerFixture(page);
  const queries = [];
  await page.route("**/api/files/entries**", async (route) => {
    const url = new URL(route.request().url());
    const query = Object.fromEntries(url.searchParams);
    queries.push(query);
    const pageNumber = Number(query.page || 1);
    return route.fulfill({
      json: {
        path: "/home/test",
        parent: "/home",
        entries: [entry(pageNumber === 1 ? "first.txt" : "second.txt", "file")],
        total: 2,
        page: pageNumber,
        pageSize: 1,
        hasMore: pageNumber === 1,
        snapshotId: "stable-snapshot",
      },
    });
  });
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest");
  await page.getByRole("button", { name: "Weitere Dateien" }).click();
  await expect(
    page.getByRole("button", { name: "second.txt", exact: true }),
  ).toBeVisible();
  expect(queries.at(-1)).toMatchObject({ page: "2", snapshot: "stable-snapshot" });
  await page.getByLabel("Sortieren nach").selectOption("size");
  await expect(
    page.getByRole("button", { name: "first.txt", exact: true }),
  ).toBeVisible();
  expect(queries.at(-1).sort).toBe("size");
  expect(queries.at(-1).snapshot).toBeUndefined();
});

test("a same-session working-directory change resets stale relative selection", async ({
  page,
}) => {
  const { state } = await fixture(page);
  const session = {
    id: "cwd-session",
    name: "Changing project",
    tool: "shell",
    cwd: "/home/test/one",
    status: "running",
    accountId: "local-shell",
  };
  state.sessions.push(session);
  const entries = [];
  await page.route("**/api/sessions/cwd-session/files/explorer/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/sessions/cwd-session/files/explorer/jobs")
      return route.fulfill({ json: { jobs: [], nextCursor: null } });
    if (url.pathname.endsWith("/context"))
      return route.fulfill({
        json: {
          ...context,
          scopeId: `f1:${session.cwd.split("/").at(-1)}`,
          kind: "project",
          root: session.cwd,
        },
      });
    if (url.pathname.endsWith("/preferences"))
      return route.fulfill({ json: { favorites: [], showHidden: false } });
    if (url.pathname.endsWith("/metadata"))
      return route.fulfill({ json: entry("old.txt", "file", "stale") });
    if (url.pathname.endsWith("/preview"))
      return route.fulfill({ json: { type: "text", text: "old" } });
    const selectedPath = url.searchParams.get("path") || "";
    entries.push({ root: session.cwd, path: selectedPath });
    return route.fulfill({
      json: {
        path: selectedPath,
        parent: selectedPath ? "" : null,
        entries: [],
        total: 0,
        page: 1,
        pageSize: 200,
        hasMore: false,
        snapshotId: `snapshot:${session.cwd}`,
      },
    });
  });
  await page.goto(
    baseURL + "/sessions/cwd-session/files?path=stale&file=stale%2Fold.txt",
  );
  await expect(page.getByRole("textbox", { name: "Pfad" })).toHaveValue("stale");
  session.cwd = "/home/test/two";
  await expect(page.getByRole("textbox", { name: "Pfad" })).toHaveValue("", {
    timeout: 7000,
  });
  await expect(page).toHaveURL(/\/sessions\/cwd-session\/files$/);
  expect(entries.at(-1)).toEqual({ root: "/home/test/two", path: "" });
});
