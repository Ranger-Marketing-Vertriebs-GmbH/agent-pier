import { test, expect } from "@playwright/test";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

const path = "/home/test/readme.txt";
const version = (text, value) => ({
  path,
  resolvedPath: path,
  text,
  bom: false,
  lineEnding: "lf",
  revision: `d1:${String(value).repeat(64)}`,
  metadataRevision: `e1:${String(value).repeat(64)}`,
  readOnly: false,
});

test("endpoint-mocked first, second and third revisions require fresh replacement consent", async ({
  page,
}, testInfo) => {
  await explorerFixture(page);
  const writes = [];
  let reads = 0;
  await page.route("**/api/files/text**", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      writes.push(request.headers());
      if (writes.length <= 2)
        return route.fulfill({
          status: 409,
          json: { code: "FILE_CONFLICT_CHANGED", args: {} },
        });
      return route.fulfill({
        json: {
          path,
          revision: `d1:${"4".repeat(64)}`,
          metadataRevision: `e1:${"4".repeat(64)}`,
        },
      });
    }
    reads++;
    await route.fulfill({
      json:
        reads === 1
          ? version("original", 1)
          : reads === 2
            ? version("disk", 2)
            : version("third disk", 3),
    });
  });
  await selectEnglish(page);
  await page.goto(
    `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`,
  );
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const editor = page.getByRole("textbox", { name: `Document content: ${path}` });
  await editor.fill("draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Conflict comparison" });
  await expect(comparison).toBeVisible();
  await expect(page.locator(".cm-mergeView")).toContainText("draft");
  await expect(page.locator(".cm-mergeView")).toContainText("disk");
  await comparison.screenshot({
    path: testInfo.outputPath("conflict-english-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 500 });
  await comparison.scrollIntoViewIfNeeded();
  await comparison.screenshot({
    path: testInfo.outputPath("conflict-english-mobile.png"),
  });
  await page
    .getByRole("button", { name: "Replace at current revision", exact: true })
    .click();
  await expect(page.locator(".cm-mergeView")).toContainText("third disk");
  expect(writes[1]["if-match"]).toBe(JSON.stringify(`d1:${"2".repeat(64)}`));
  await page
    .getByRole("button", { name: "Replace at current revision", exact: true })
    .click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  expect(writes[2]["if-match"]).toBe(JSON.stringify(`d1:${"3".repeat(64)}`));
});

test("a clean active document reports external change and reloads only on request", async ({
  page,
}) => {
  await explorerFixture(page);
  let reads = 0;
  await page.route("**/api/files/text**", async (route) => {
    reads++;
    await route.fulfill({
      json: reads === 1 ? version("original", 1) : version("disk", 2),
    });
  });
  await page.route("**/api/files/metadata**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("view") !== "document") return route.fallback();
    await route.fulfill({
      json: {
        path,
        resolvedPath: path,
        metadataRevision: `e1:${"2".repeat(64)}`,
      },
    });
  });
  await selectEnglish(page);
  await page.goto(
    `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`,
  );
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const editor = page.getByRole("textbox", { name: `Document content: ${path}` });
  await expect(page.getByRole("button", { name: "Reload disk version" })).toBeVisible();
  await expect(editor).toHaveText("original");
  await page.getByRole("button", { name: "Reload disk version" }).click();
  await expect(editor).toHaveText("disk");
});

test("document metadata polling pauses while hidden and resumes when visible", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__documentVisible = false;
    Object.defineProperty(Document.prototype, "hidden", {
      configurable: true,
      get: () => !window.__documentVisible,
    });
  });
  await explorerFixture(page);
  let metadataReads = 0;
  await page.route("**/api/files/text**", (route) =>
    route.fulfill({ json: version("original", 1) }),
  );
  await page.route("**/api/files/metadata**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("view") !== "document") return route.fallback();
    metadataReads++;
    await route.fulfill({
      json: {
        path,
        resolvedPath: path,
        metadataRevision: `e1:${"1".repeat(64)}`,
      },
    });
  });
  await selectEnglish(page);
  await page.goto(
    `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`,
  );
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  await page.waitForTimeout(300);
  expect(metadataReads).toBe(0);
  await page.evaluate(() => {
    window.__documentVisible = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => metadataReads).toBe(1);
  await page.evaluate(() => {
    window.__documentVisible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(5200);
  expect(metadataReads).toBe(1);
});
