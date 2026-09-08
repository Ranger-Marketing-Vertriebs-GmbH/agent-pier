import { test, expect } from "@playwright/test";
import { fixture, openRepositories } from "../helpers/repository-browser.js";
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
  await page.getByLabel("Repository-URL oder owner/repo").fill("acme/project");
  await page.getByLabel("Neuer Ordnername").fill("project");
  await page.getByRole("button", { name: "Ordner auswählen", exact: true }).click();
  await page.getByRole("button", { name: "Ordner anlegen", exact: true }).click();
  await page.getByLabel("Ordnername", { exact: true }).fill("Projects");
  await page.getByLabel("Ordnername", { exact: true }).press("Enter");
  await expect(page.getByRole("dialog").locator(".directory-path")).toContainText(
    "/home/test/Projects",
  );
  await page.getByRole("button", { name: "Diesen Ordner verwenden" }).click();
  await expect(page.getByLabel("Übergeordneter Ordner", { exact: true })).toHaveValue(
    "/home/test/Projects",
  );
  expect(created).toEqual([{ path: "/home/test", name: "Projects" }]);
  expect(writes.filter((write) => write.path.endsWith("/clone"))).toHaveLength(0);
});

for (const mobile of [false, true])
  test(`project files preserve folder and text preview across reload (${mobile ? "mobile" : "desktop"})`, async ({
    page,
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
    await page.route("**/api/sessions/files-session/files**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/content"))
        return route.fulfill({
          json: { type: "text", text: "Hello <script>world</script>" },
        });
      const folder = url.searchParams.get("path") || "";
      return route.fulfill({
        json: {
          path: folder,
          page: 1,
          total: 1,
          hasMore: false,
          entries: folder
            ? [{ name: "hello.txt", path: "src/hello.txt", type: "file" }]
            : [{ name: "src", path: "src", type: "directory" }],
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
      path: `/tmp/agentpier-files-${mobile ? "mobile" : "desktop"}.png`,
    });
    await page.getByRole("button", { name: "Vorschau schließen" }).click();
    await page.goBack();
    await expect(page.locator(".file-preview pre")).toBeVisible();
  });
