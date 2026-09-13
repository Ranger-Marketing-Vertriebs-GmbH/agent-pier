import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(page, target) {
  const explorerBase = "/api/sessions/links/files/explorer";
  const previews = [];
  const explorerRequests = [];
  const unexpectedExplorerRequests = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith(explorerBase))
      explorerRequests.push({
        method: request.method(),
        path: url.pathname.slice(explorerBase.length),
        query: Object.fromEntries(url.searchParams),
      });
    let json = {};
    if (url.pathname === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [],
        home: "/fixture",
        sessions: [
          {
            id: "links",
            name: "File links",
            tool: "codex",
            cwd: "/fixture/repo",
            status: "running",
          },
        ],
      };
    else if (url.pathname.endsWith("/chat"))
      json = {
        availability: "ready",
        tasks: [],
        messages: [
          {
            id: "answer",
            role: "assistant",
            text: `[Abnahmebericht](<${target}>)\n\n[Website](https://example.com/report)`,
          },
        ],
      };
    else if (url.pathname === `${explorerBase}/context`)
      json = {
        scopeId: "f1:links-fixture",
        kind: "project",
        root: "/fixture/repo",
        home: "/fixture",
        readOnly: false,
        limits: { listPageSize: 200, listEntries: 100000 },
      };
    else if (url.pathname === `${explorerBase}/preferences`)
      json = { favorites: [], showHidden: false };
    else if (url.pathname === `${explorerBase}/entries`)
      json = {
        path: url.searchParams.get("path") || "",
        parent: null,
        entries: [],
        total: 0,
        page: 1,
        pageSize: 200,
        hasMore: false,
        snapshotId: "snapshot-links",
      };
    else if (url.pathname === `${explorerBase}/metadata`) {
      const file = url.searchParams.get("path");
      if (file.startsWith("/"))
        return route.fulfill({
          status: 403,
          json: {
            error: "Dateioperation fehlgeschlagen.",
            code: "FILE_OUTSIDE_SCOPE",
            args: {},
          },
        });
      json = {
        path: file,
        name: file.split("/").at(-1),
        type: "file",
        size: 36,
        modifiedAt: "2026-09-13T10:00:00.000Z",
        mode: 0o600,
        readable: true,
        writable: true,
        linkTarget: null,
        revision: "e1:fixture",
      };
    } else if (url.pathname === `${explorerBase}/preview`) {
      const file = url.searchParams.get("path");
      previews.push(file);
      json = {
        path: file,
        type: "text",
        text: "# Acceptance report\nVerified results",
      };
    } else if (url.pathname.startsWith(explorerBase)) {
      unexpectedExplorerRequests.push({ method: request.method(), path: url.pathname });
      return route.fulfill({
        status: 500,
        json: { error: "Unexpected explorer request", code: "FILE_IO_ERROR", args: {} },
      });
    }
    return route.fulfill({ json });
  });
  await page.goto(baseURL + "/sessions/links/chat");
  return { explorerRequests, previews, unexpectedExplorerRequests };
}

for (const target of [
  "docs/report.md",
  "/fixture/repo/docs/report.md:12",
  "file:///fixture/repo/docs/report.md#L12",
  "docs/report%20final.md",
]) {
  test(`local chat link opens the project preview: ${target}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const requests = await fixture(page, target);
    await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
    await expect(page.getByLabel("Dateivorschau")).toContainText("Verified results");
    const expectedPath = target.includes("final")
      ? "docs/report final.md"
      : "docs/report.md";
    expect(requests.previews).toEqual([expectedPath]);
    expect(requests.explorerRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", path: "/context" }),
        expect.objectContaining({ method: "GET", path: "/preferences" }),
        expect.objectContaining({
          method: "GET",
          path: "/entries",
          query: expect.objectContaining({ path: "" }),
        }),
        { method: "GET", path: "/metadata", query: { path: expectedPath } },
        { method: "GET", path: "/preview", query: { path: expectedPath } },
      ]),
    );
    expect(requests.unexpectedExplorerRequests).toEqual([]);
    expect(page.context().pages()).toHaveLength(1);
    if (target === "docs/report.md")
      await page.screenshot({ path: ".cache/chat-file-preview-mobile.png" });
    await page.goBack();
    await expect(
      page.getByRole("link", { name: "Abnahmebericht", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Website", exact: true }),
    ).toHaveAttribute("href", "https://example.com/report");
  });
}

test("outside-project links show the bounded file error inside the app", async ({
  page,
}) => {
  const requests = await fixture(page, "/outside/report.md");
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "außerhalb des Projektverzeichnisses",
  );
  expect(requests.explorerRequests).toContainEqual({
    method: "GET",
    path: "/metadata",
    query: { path: "/outside/report.md" },
  });
  expect(requests.previews).toEqual([]);
  expect(requests.unexpectedExplorerRequests).toEqual([]);
  await expect(page.locator("body")).not.toContainText("npm run build");
});
