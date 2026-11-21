// AGENTPIER-455 B2 and the editor's controls: a save refused by a change on disk
// says so in words, stays out of Activity, and the toolbar uses the shared controls.
import { test, expect } from "../helpers/browser-test.js";
import {
  explorerContext,
  explorerFixture,
  selectEnglish,
} from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

const path = "/home/test/readme.txt";
const editorURL = `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`;
const document = (text, digit) => ({
  path,
  resolvedPath: path,
  text,
  bom: false,
  lineEnding: "lf",
  readOnly: false,
  revision: `d1:${digit.repeat(64)}`,
  metadataRevision: `e1:${digit.repeat(64)}`,
});

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`a save refused by a change on disk explains itself and leaves Activity calm (${label})`, async ({
    page,
  }) => {
    await explorerFixture(page);
    await page.routeWebSocket("**/api/**", (socket) => socket.close());
    let reads = 0;
    await page.route("**/api/files/text**", (route) => {
      if (route.request().method() === "PUT")
        return route.fulfill({ status: 409, json: { code: "FILE_CONFLICT_CHANGED" } });
      reads += 1;
      return route.fulfill({
        json: reads === 1 ? document("hello\n", "1") : document("on disk\n", "2"),
      });
    });
    // The refused save is a failed text_save job on the server.
    await page.route(/\/api\/files\/jobs(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          jobs: [
            {
              id: "save-1",
              scopeId: explorerContext.scopeId,
              kind: "text_save",
              status: "failed",
              completedEntries: 0,
              totalEntries: 1,
              completedBytes: 0,
              totalBytes: 6,
              conflict: null,
              issue: { code: "FILE_CONFLICT_CHANGED", args: {} },
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await page.setViewportSize(viewport);
    await selectEnglish(page);
    await page.goto(editorURL);
    await page.getByRole("button", { name: "Open in editor", exact: true }).click();
    const content = page.getByRole("textbox", { name: `Document content: ${path}` });
    await expect(content).toContainText("hello");
    // The tab shows the file name; its accessible name stays the full path.
    const tab = page.getByRole("tab", { name: path, exact: true });
    await expect(tab).toHaveText("readme.txt");
    // BOM is the shared Checkbox: the box before its label, on one line.
    const bom = page.getByRole("checkbox", { name: "UTF-8 BOM", exact: true });
    const box = await bom.boundingBox();
    const text = await page.getByText("UTF-8 BOM", { exact: true }).boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(text.x);
    expect(Math.abs(box.y + box.height / 2 - (text.y + text.height / 2))).toBeLessThan(
      text.height,
    );
    await content.press("End");
    await content.pressSequentially(" draft");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText(
      "The file changed on disk after you opened it. Compare your draft with the disk version below.",
    );
    await expect(alert).not.toContainText("FILE_CONFLICT_CHANGED");
    await expect(page.getByRole("region", { name: "Conflict comparison" })).toBeVisible();
    // Neither the toolbar nor the phone's preview bar calls for attention.
    await expect(page.getByText("Needs attention")).toHaveCount(0);
    if (label === "desktop") {
      await page.getByRole("button", { name: /^Activity/ }).click();
      await expect(
        page.getByRole("region", { name: "File jobs", exact: true }),
      ).not.toContainText("Save text");
    }
  });
}
