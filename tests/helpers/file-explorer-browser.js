import { expect } from "@playwright/test";
import { fixture } from "./repository-browser.js";
import { baseURL } from "./browser.js";

export const explorerContext = {
  scopeId: "f1:global-fixture",
  kind: "global",
  root: "/",
  home: "/home/test",
  readOnly: false,
  limits: { listPageSize: 200, listEntries: 100000 },
};

export function explorerEntry(name, type, folder = "/home/test", extra = {}) {
  return {
    path: `${folder}/${name}`.replace("//", "/"),
    name,
    type,
    size: type === "file" ? 12 : null,
    modifiedAt: "2026-09-13T10:00:00.000Z",
    mode: type === "directory" ? 0o40700 : 0o100600,
    readable: type === "symlink" ? null : true,
    writable: type === "symlink" ? null : true,
    linkTarget: type === "symlink" ? "docs" : null,
    revision: "e1:fixture",
    ...extra,
  };
}

export function explorerListing(path, entries = [], extra = {}) {
  return {
    path,
    parent: path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/",
    entries,
    total: entries.length,
    page: 1,
    pageSize: 200,
    hasMore: false,
    snapshotId: `snapshot:${path}`,
    ...extra,
  };
}

export async function explorerFixture(
  page,
  initialPreferences = { favorites: [], showHidden: false },
) {
  const data = await fixture(page);
  data.repositories.projects.push({
    id: "project-one",
    name: "Project One",
    path: "/work/project-one",
    url: "https://github.com/acme/project-one.git",
    credentialId: "personal",
    createdAt: "2026-09-13T10:00:00Z",
  });
  let preferences = initialPreferences;
  const requests = [];
  await page.route("**/api/files/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({
      method: request.method(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      scope: request.headers()["x-file-scope"],
    });
    if (url.pathname === "/api/files/jobs")
      return route.fulfill({ json: { jobs: [], nextCursor: null } });
    if (url.pathname.endsWith("/context"))
      return route.fulfill({ json: explorerContext });
    if (url.pathname.endsWith("/preferences")) {
      if (request.method() === "PATCH")
        preferences = { ...preferences, ...request.postDataJSON() };
      return route.fulfill({ json: preferences });
    }
    const selectedPath = url.searchParams.get("path") || explorerContext.home;
    if (url.pathname.endsWith("/metadata")) {
      if (url.searchParams.get("view") === "document")
        return route.fulfill({
          json: {
            path: selectedPath,
            resolvedPath: selectedPath,
            metadataRevision: `e1:${"1".repeat(64)}`,
          },
        });
      const name = selectedPath.split("/").at(-1);
      return route.fulfill({
        json: explorerEntry(
          name,
          name === "linked-docs" ? "symlink" : "file",
          "/home/test",
        ),
      });
    }
    if (url.pathname.endsWith("/preview"))
      return route.fulfill({ json: { type: "text", text: "Hello explorer" } });
    if (url.pathname.endsWith("/entries")) {
      const entries =
        selectedPath === "/home/test/docs" || selectedPath === "/home/test/linked-docs"
          ? [explorerEntry("guide.txt", "file", selectedPath)]
          : [
              explorerEntry("docs", "directory"),
              explorerEntry("linked-docs", "symlink"),
              explorerEntry("readme.txt", "file"),
            ];
      return route.fulfill({
        json: explorerListing(selectedPath, entries, {
          page: Number(url.searchParams.get("page") || 1),
          snapshotId: "snapshot-1",
        }),
      });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected explorer route" } });
  });
  return { ...data, requests, getPreferences: () => preferences };
}

export async function selectEnglish(page) {
  await page.goto(baseURL + "/settings");
  await page.getByLabel("Sprache", { exact: true }).selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
}
