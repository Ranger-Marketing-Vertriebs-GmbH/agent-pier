import { test, expect } from "@playwright/test";
import {
  explorerFixture,
  explorerContext,
  explorerEntry,
  explorerListing,
  selectEnglish,
} from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

test("English Files keeps idle transfers out of the list and opens upload on request", async ({
  page,
}) => {
  await explorerFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await expect(
    page.getByRole("button", { name: "readme.txt", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toBeHidden();
  await expect(page.getByRole("region", { name: "File jobs", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toBeVisible();
  await expect(page.getByLabel("Upload files", { exact: true })).toBeEnabled();
});

test("mobile preview replaces the list and returns keyboard focus to the opened file", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await explorerFixture(page);
  await page.goto(baseURL + "/files");
  const file = page.getByRole("button", { name: "readme.txt", exact: true });
  await file.click();
  await expect(page.locator(".file-preview pre")).toHaveText("Hello explorer");
  await expect(
    page.getByRole("region", { name: "Dateiliste", exact: true }),
  ).toBeHidden();
  await expect(page.locator(".file-properties dl")).toBeHidden();
  await page.getByText("Dateidetails", { exact: true }).click();
  await expect(page.locator(".file-properties dl")).toContainText(
    "/home/test/readme.txt",
  );
  await page.getByRole("button", { name: "Zurück zur Dateiliste", exact: true }).click();
  await expect(file).toBeVisible();
  await expect(file).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("mobile failed preview still offers a return to the list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await explorerFixture(page);
  await page.route("**/api/files/metadata**", (route) =>
    route.fulfill({ status: 403, json: { error: "Access denied" } }),
  );
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect(page.locator(".file-properties [role=alert]")).toBeVisible();
  await page.getByRole("button", { name: "Zurück zur Dateiliste", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "readme.txt", exact: true }),
  ).toBeVisible();
});

test("mobile preview keeps its back action above expanded transfers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await explorerFixture(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Zurück zur Dateiliste", exact: true }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Zurück zur Dateiliste", exact: true }).click();
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toBeVisible();
});

test("collapsed upload keeps a delayed local selection failure visible", async ({
  page,
}) => {
  await explorerFixture(page);
  await page.goto(baseURL + "/files");
  await expect(
    page.getByRole("button", { name: "readme.txt", exact: true }),
  ).toBeVisible();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["test"], "example.txt"));
    Object.defineProperty(data, "items", {
      value: [
        {
          kind: "file",
          webkitGetAsEntry: () => ({
            name: "example",
            isDirectory: true,
            createReader: () => ({
              readEntries: (_done, fail) => {
                window.failSelection = () => fail(new Error("selection failed"));
              },
            }),
          }),
        },
      ],
    });
    return data;
  });
  await page.locator(".file-explorer").dispatchEvent("drop", { dataTransfer: transfer });
  const upload = page.getByRole("button", { name: "Hochladen", exact: true });
  await expect(upload).toHaveAttribute("aria-expanded", "true");
  await upload.click();
  await expect
    .poll(() => page.evaluate(() => typeof window.failSelection))
    .toBe("function");
  await page.evaluate(() => window.failSelection());
  await expect(upload).toContainText("Prüfung erforderlich");
  await expect(upload).toHaveAccessibleDescription("Prüfung erforderlich");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect(page.locator(".explorer-preview-attention")).toBeVisible();
  await page.locator(".explorer-preview-attention button").click();
  await expect(upload).toHaveAttribute("aria-expanded", "true");
  await upload.click();
  await upload.click();
  await expect(page.locator(".file-uploads [role=alert]")).toBeVisible();
});

for (const language of ["de", "en"])
  test(`shared explorer stays inside the app shell in ${language} on desktop and mobile`, async ({
    page,
    browserName,
  }) => {
    const { state } = await explorerFixture(page);
    state.sessions.push({
      id: "layout",
      name: "Explorer UX",
      tool: "codex",
      cwd: "/home/test/agent-pier",
      status: "running",
      accountId: "local-codex",
    });
    await page.route("**/api/sessions/layout/files/explorer/**", async (route) => {
      const url = new URL(route.request().url());
      const suffix = url.pathname.split("/explorer")[1];
      if (suffix === "/context")
        return route.fulfill({
          json: {
            ...explorerContext,
            kind: "project",
            root: "/home/test/agent-pier",
            scopeId: "f1:layout",
          },
        });
      if (suffix === "/preferences")
        return route.fulfill({ json: { favorites: [], showHidden: false } });
      if (suffix === "/jobs")
        return route.fulfill({ json: { jobs: [], nextCursor: null } });
      if (suffix === "/entries")
        return route.fulfill({
          json: explorerListing(
            "",
            [
              explorerEntry("docs", "directory", "", { path: "docs" }),
              explorerEntry("README.md", "file", "", { path: "README.md" }),
            ],
            { parent: null },
          ),
        });
      if (suffix === "/metadata")
        return route.fulfill({
          json: explorerEntry("README.md", "file", "", { path: "README.md" }),
        });
      if (suffix === "/preview")
        return route.fulfill({
          json: {
            type: "text",
            text: "# AgentPier\n\nYour terminal. Everywhere.\n\n## Getting started\n\nnpm ci\nnpm run build\nnpm start",
          },
        });
      return route.fulfill({ status: 500, json: { error: "Unexpected test request" } });
    });
    if (language === "en") await selectEnglish(page);
    const issues = [];
    page.on("pageerror", (error) => issues.push(error.message));
    for (const session of [false, true]) {
      for (const mobile of [false, true]) {
        await page.setViewportSize(
          mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
        );
        await page.goto(baseURL + (session ? "/sessions/layout/files" : "/files"));
        const file = page.getByRole("button", {
          name: session ? "README.md" : "readme.txt",
          exact: true,
        });
        await expect(file).toBeVisible();
        if (session)
          await expect(page.locator(".terminal-topbar")).toContainText("Terminal");
        await expect(page.locator(mobile ? ".mobile-brand" : ".brand")).toContainText(
          "AgentPier",
        );
        if (mobile)
          await expect(page.locator(".explorer-activity-toggle")).toBeInViewport({
            ratio: 1,
          });
        if (session && !mobile) {
          await file.click();
          await expect(page.locator(".file-preview pre")).toContainText("AgentPier");
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `.superpowers/files-ux/${browserName}-${language}-${session ? "session" : "remote"}-${mobile ? "mobile" : "desktop"}.png`,
        });
        if (mobile) {
          await file.click();
          await expect(page.locator(".file-preview pre")).toBeVisible();
          await page.screenshot({
            path: `.superpowers/files-ux/${browserName}-${language}-${session ? "session" : "remote"}-preview-mobile.png`,
          });
        }
      }
    }
    expect(issues).toEqual([]);
  });
