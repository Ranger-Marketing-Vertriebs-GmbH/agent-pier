import { test, expect } from "@playwright/test";
import {
  explorerFixture,
  explorerContext,
  selectEnglish,
} from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";
const path = "/home/test/readme.txt";
const revision = `d1:${"1".repeat(64)}`;
const metadataRevision = `e1:${"1".repeat(64)}`;
const editorURL = `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`;
async function setup(page, extra = {}) {
  await explorerFixture(page);
  const saves = [];
  await page.route("**/api/files/text**", async (route) => {
    const request = route.request();
    const selected = new URL(request.url()).searchParams.get("path");
    if (request.method() === "PUT") {
      saves.push({
        bytes: request.postDataBuffer(),
        headers: request.headers(),
        path: selected,
      });
      return route.fulfill({
        json: {
          path: selected,
          revision: `d1:${"2".repeat(64)}`,
          metadataRevision: `e1:${"2".repeat(64)}`,
        },
      });
    }
    return route.fulfill({
      json: {
        path: selected,
        resolvedPath: selected,
        text: "Hello\r\nworld\r\n",
        bom: true,
        lineEnding: "crlf",
        readOnly: false,
        revision,
        metadataRevision,
        ...extra,
      },
    });
  });
  return saves;
}

test("English editor keeps full history across tab and app unmount, saves CRLF/BOM, and offers mobile search", async ({
  page,
}, testInfo) => {
  const saves = await setup(page);
  let contextReads = 0,
    releaseContext;
  const freshContext = new Promise((resolve) => {
    releaseContext = resolve;
  });
  await page.route("**/api/files/context", async (route) => {
    if (++contextReads === 2) await freshContext;
    await route.fulfill({ json: explorerContext });
  });
  await selectEnglish(page);
  await page.goto(editorURL);
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const content = page.getByRole("textbox", { name: `Document content: ${path}` });
  await expect(content).toBeVisible();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await content.fill("Changed\nworld\n");
  await page.getByRole("button", { name: "Close document", exact: true }).click();
  await expect(
    page.getByText("Unsaved draft retained. Save it before closing."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(content).toContainText("Changed");
  await expect.poll(() => contextReads).toBe(2);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await content.press("ControlOrMeta+s");
  expect(saves).toHaveLength(0);
  releaseContext();
  await content.press("ControlOrMeta+z");
  await expect(content).toContainText("Hello");
  await content.press("ControlOrMeta+Shift+z");
  await expect(content).toContainText("Changed");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await content.press("ControlOrMeta+s");
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].bytes).toEqual(Buffer.from("\uFEFFChanged\r\nworld\r\n"));
  expect(saves[0].headers["if-match"]).toBe(JSON.stringify(revision));
  await page.getByRole("button", { name: "Search and replace", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Find", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Find", exact: true }).fill("world");
  await page.getByRole("textbox", { name: "Replace", exact: true }).fill("earth");
  await page.getByRole("button", { name: "replace all", exact: true }).click();
  await expect(content).toContainText("earth");
  await expect(page.getByText("Unsaved changes.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("editor-english-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(page.locator(".nav-backdrop")).not.toBeVisible();
  await page.locator(".file-editor").scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("editor-english-mobile.png"),
    fullPage: true,
  });
});

test("read-only text retains preview Copy all and only permits independent fresh Save As", async ({
  page,
}) => {
  const saves = await setup(page, { readOnly: true });
  await selectEnglish(page);
  await page.goto(editorURL);
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "Copy all", exact: true })).toBeVisible();
  await page.getByLabel("Save As path", { exact: true }).fill("/home/test/copy.txt");
  await page.getByRole("button", { name: "Save new copy", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].headers["if-none-match"]).toBe("*");
  expect(saves[0].headers["if-match"]).toBeUndefined();
  await expect(page.getByRole("tab", { name: path, exact: true })).toBeVisible();
});

test("German mixed-line document requires explicit format and localizes built-in search", async ({
  page,
}) => {
  const saves = await setup(page, { text: "a\rb\r\n", lineEnding: "mixed" });
  await page.goto(editorURL);
  await page.getByRole("button", { name: "Im Editor öffnen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Speichern", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Zeilenenden", exact: true })
    .selectOption("lf");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].bytes).toEqual(Buffer.from("\uFEFFa\nb\n"));
  await page.getByRole("button", { name: "Suchen und ersetzen", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Suchen", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "alle ersetzen", exact: true }),
  ).toBeVisible();
});

test("existing SaveAs target is inspected freshly and only the latest explicit consent permits replacement", async ({
  page,
}) => {
  await setup(page, { readOnly: true });
  const delayed = [];
  const writes = [];
  let targetReads = 0;
  await page.route("**/api/files/text**", async (route) => {
    const req = route.request();
    const selected = new URL(req.url()).searchParams.get("path");
    if (selected !== "/home/test/existing.txt") return route.fallback();
    if (req.method() === "PUT") {
      writes.push(req.headers());
      if (req.headers()["if-none-match"])
        return route.fulfill({
          status: 409,
          json: { code: "FILE_CONFLICT_CHANGED", args: {} },
        });
      return route.fulfill({
        json: {
          path: selected,
          revision: `d1:${"4".repeat(64)}`,
          metadataRevision: `e1:${"4".repeat(64)}`,
        },
      });
    }
    targetReads++;
    const doc = {
      path: selected,
      resolvedPath: selected,
      text: "target",
      bom: false,
      lineEnding: "lf",
      readOnly: false,
      revision: `d1:${String(targetReads + 1).repeat(64)}`,
      metadataRevision: `e1:${String(targetReads + 1).repeat(64)}`,
    };
    if (targetReads === 1) {
      delayed.push(() => route.fulfill({ json: doc }));
      return;
    }
    return route.fulfill({ json: doc });
  });
  await selectEnglish(page);
  await page.goto(editorURL);
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  await page.getByLabel("Save As path", { exact: true }).fill("/home/test/existing.txt");
  await page.getByRole("button", { name: "Save new copy", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("FILE_CONFLICT_CHANGED");
  expect(writes.length).toBe(1);
  await page
    .getByRole("button", { name: "Inspect existing target", exact: true })
    .click();
  await expect.poll(() => targetReads).toBe(1);
  await page
    .getByRole("button", { name: "Inspect existing target", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Replace this target", exact: true }),
  ).toBeVisible();
  await delayed[0]();
  await page.getByRole("button", { name: "Replace this target", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]["if-match"]).toBe(JSON.stringify(`d1:${"3".repeat(64)}`));
  expect(writes[1]["if-none-match"]).toBeUndefined();
  await expect(page.getByRole("tab", { name: path, exact: true })).toBeVisible();
});
