import { test, expect } from "@playwright/test";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";
const path = "/home/test/readme.txt";
const result = {
  path,
  revision: `d1:${"2".repeat(64)}`,
  metadataRevision: `e1:${"2".repeat(64)}`,
};
async function setup(page, put) {
  await explorerFixture(page);
  await page.route("**/api/files/text**", (route) =>
    route.request().method() === "PUT"
      ? put(route)
      : route.fulfill({
          json: {
            ...result,
            resolvedPath: path,
            text: "original",
            bom: false,
            lineEnding: "lf",
            readOnly: false,
          },
        }),
  );
  await selectEnglish(page);
  await page.goto(
    `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`,
  );
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const content = page.getByRole("textbox", { name: `Document content: ${path}` });
  await expect(content).toBeVisible();
  return content;
}
for (const lost of [false, true]) {
  test(`close preserves ${lost ? "unresolved" : "pending"} save after undo and late completion`, async ({
    page,
  }) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const requests = [];
    const content = await setup(page, async (route) => {
      requests.push({
        id: route.request().headers()["x-file-request"],
        body: route.request().postData(),
      });
      if (lost && requests.length === 1) return route.fulfill({ status: 200, body: "{" });
      await held;
      return route.fulfill({ json: result });
    });
    await content.press("ControlOrMeta+End");
    await page.keyboard.type(" changed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    if (lost)
      await expect(page.getByRole("alert")).toContainText("FILE_INVALID_RESPONSE");
    await content.press("ControlOrMeta+z");
    await expect(content).toHaveText("original");
    await expect(page.getByRole("tab", { name: path, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close document", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(content).toHaveText("original");
    expect(requests).toHaveLength(1);
    if (lost) {
      await content.press("ControlOrMeta+Shift+z");
      await expect(content).toHaveText("original changed");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => requests.length).toBe(2);
      expect(requests[1]).toEqual(requests[0]);
      await content.press("ControlOrMeta+z");
    }
    release();
    await expect(
      page.getByText("Saved the attempted version. Newer edits remain unsaved."),
    ).toBeVisible();
    await expect(content).toHaveText("original");
    await content.press("ControlOrMeta+Shift+z");
    await expect(content).toHaveText("original changed");
    await expect(page.getByRole("tab", { name: path, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close document", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(0);
  });
}

test("visible search focuses Find and typing preserves document selection and undo on desktop and mobile", async ({
  page,
}, testInfo) => {
  const content = await setup(page, (route) => route.fulfill({ json: result }));
  await content.press("ControlOrMeta+End");
  await page.keyboard.type(" changed");
  await content.press("ArrowLeft");
  for (const mobile of [false, true]) {
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() =>
          page.locator(".sidebar").evaluate((node) => node.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      await expect(page.locator(".nav-backdrop")).not.toBeVisible();
    }
    await content.focus();
    const selection = await page.evaluate(() => ({
      anchor: getSelection().anchorOffset,
      focus: getSelection().focusOffset,
    }));
    await page.getByRole("button", { name: "Search and replace", exact: true }).click();
    const find = page.getByRole("textbox", { name: "Find", exact: true });
    await expect(find).toBeFocused();
    await page.keyboard.type("needle");
    await expect(find).toHaveValue("needle");
    await expect(content).toHaveText("original changed");
    await page.screenshot({
      path: testInfo.outputPath(`search-focus-${mobile ? "mobile" : "desktop"}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "close", exact: true }).click();
    await content.focus();
    expect(
      await page.evaluate(() => ({
        anchor: getSelection().anchorOffset,
        focus: getSelection().focusOffset,
      })),
    ).toEqual(selection);
    await content.press("ControlOrMeta+z");
    await expect(content).toHaveText("original");
    await content.press("ControlOrMeta+Shift+z");
    await expect(content).toHaveText("original changed");
  }
});
