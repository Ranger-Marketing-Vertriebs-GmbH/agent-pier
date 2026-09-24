import { test, expect } from "@playwright/test";
import {
  fixture,
  openCloneDialog,
  openRepositories,
} from "../helpers/repository-browser.js";
import { baseURL } from "../helpers/browser.js";

test("clone folder picker creates and chooses a server directory without submitting the clone", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  const created = [];
  await page.route("**/api/directories**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      created.push(body);
      return route.fulfill({ status: 201, json: { path: `${body.path}/${body.name}` } });
    }
    const path = new URL(route.request().url()).searchParams.get("path");
    return route.fulfill({ json: { path, parent: "/home", entries: [] } });
  });
  await openRepositories(page);
  const clone = await openCloneDialog(page);
  await clone.getByLabel("Repository-URL oder owner/repo").fill("acme/project");
  await clone.getByLabel("Neuer Ordnername").fill("project");
  await clone.getByRole("button", { name: "Ordner auswählen", exact: true }).click();
  await page.getByRole("button", { name: "Ordner anlegen", exact: true }).click();
  await page.getByLabel("Ordnername", { exact: true }).fill("Projects");
  await page.getByLabel("Ordnername", { exact: true }).press("Enter");
  await expect(
    page
      .getByRole("dialog", { name: "Übergeordneter Ordner" })
      .locator(".directory-path"),
  ).toContainText("/home/test/Projects");
  await page.getByRole("button", { name: "Diesen Ordner verwenden" }).click();
  await expect(clone.getByLabel("Übergeordneter Ordner", { exact: true })).toHaveValue(
    "/home/test/Projects",
  );
  expect(created).toEqual([{ path: "/home/test", name: "Projects" }]);
  expect(writes.filter((write) => write.path.endsWith("/clone"))).toHaveLength(0);
});

for (const mobile of [false, true])
  test(`project files preserve folder and text preview across reload (${mobile ? "mobile" : "desktop"})`, async ({
    page,
    browserName,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const { state } = await fixture(page);
    state.sessions.push({
      id: "files-session",
      name: "Files fixture",
      tool: "shell",
      cwd: "/home/test/project",
      status: "running",
      accountId: "local-shell",
    });
    const directoryWrites = [];
    const mkdirJob = {
      id: "mkdir-job",
      scopeId: "f1:project-fixture",
      kind: "create_directory",
      status: "completed",
      completedEntries: 1,
      totalEntries: 1,
      issue: null,
    };
    await page.route("**/api/sessions/files-session/files**", async (route) => {
      const request = route.request();
      const url = new URL(route.request().url());
      if (request.method() === "POST" && url.pathname.endsWith("/explorer/operations")) {
        const body = request.postDataJSON();
        directoryWrites.push({ path: body.target, name: body.name });
        return route.fulfill({ status: 202, json: mkdirJob });
      }
      if (url.pathname.endsWith("/jobs/mkdir-job"))
        return route.fulfill({ json: mkdirJob });
      if (url.pathname.endsWith("/explorer/jobs"))
        return route.fulfill({ json: { jobs: [], nextCursor: null } });
      if (url.pathname.endsWith("/explorer/context"))
        return route.fulfill({
          json: {
            scopeId: "f1:project-fixture",
            kind: "project",
            root: "/home/test/project",
            home: "/home/test",
            readOnly: false,
            limits: { listPageSize: 200, listEntries: 100000 },
          },
        });
      if (url.pathname.endsWith("/explorer/preferences"))
        return route.fulfill({ json: { favorites: [], showHidden: false } });
      if (url.pathname.endsWith("/explorer/metadata"))
        return route.fulfill({
          json: {
            name: "hello.txt",
            path: "src/hello.txt",
            type: "file",
            size: 28,
            modifiedAt: "2026-09-13T10:00:00.000Z",
            mode: 0o100600,
            readable: true,
            writable: true,
            linkTarget: null,
            revision: "e1:fixture",
          },
        });
      if (url.pathname.endsWith("/explorer/preview"))
        return route.fulfill({
          json: { type: "text", text: "Hello <script>world</script>" },
        });
      if (!url.pathname.endsWith("/explorer/entries"))
        return route.fulfill({ status: 500, json: { error: "Unexpected file route" } });
      const folder = url.searchParams.get("path") || "";
      const rawEntries = folder
        ? [{ name: "hello.txt", path: "src/hello.txt", type: "file", size: 28 }]
        : [{ name: "src", path: "src", type: "directory", size: null }];
      for (const created of directoryWrites)
        if (created.path === folder)
          rawEntries.push({
            name: created.name,
            path: `${folder}/${created.name}`,
            type: "directory",
            size: null,
          });
      return route.fulfill({
        json: {
          path: folder,
          parent: folder ? "" : null,
          page: 1,
          pageSize: 200,
          total: 1,
          hasMore: false,
          snapshotId: "snapshot-project",
          entries: rawEntries.map((entry) => ({
            ...entry,
            modifiedAt: "2026-09-13T10:00:00.000Z",
            mode: entry.type === "directory" ? 0o40700 : 0o100600,
            readable: true,
            writable: true,
            linkTarget: null,
            revision: "e1:fixture",
          })),
        },
      });
    });
    await page.goto(baseURL + "/sessions/files-session/files");
    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "hello.txt", exact: true }).click();
    await expect(page).toHaveURL(/files\?path=src&file=src%2Fhello.txt$/);
    await expect(page.locator(".file-preview pre")).toHaveText(
      "Hello <script>world</script>",
    );
    await page.reload();
    await expect(page.locator(".file-preview pre")).toHaveText(
      "Hello <script>world</script>",
    );
    await expect(page.locator(".file-preview script")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-de-${mobile ? "mobile-390x844" : "desktop-1440x1000"}-project-files.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", {
        name: mobile ? "Zurück zur Dateiliste" : "Vorschau schließen",
        exact: true,
      })
      .click();
    await page.goBack();
    await expect(page.locator(".file-preview pre")).toBeVisible();
    if (!mobile) {
      await page
        .getByRole("button", {
          name: mobile ? "Zurück zur Dateiliste" : "Vorschau schließen",
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "Neu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Neuer Ordner", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByLabel("Name", { exact: true })
        .fill("new-folder");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Bestätigen", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "new-folder", exact: true }),
      ).toBeVisible();
      expect(directoryWrites).toEqual([{ path: "src", name: "new-folder" }]);
    }
  });
