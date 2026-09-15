import { test, expect } from "@playwright/test";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { baseURL } from "../helpers/browser.js";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { uploadsFixture } from "../helpers/file-uploads-browser.js";

test("file shortcuts select the visible page and use the existing destructive dialog", async ({
  page,
}, testInfo) => {
  const fixture = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const list = page.getByRole("region", { name: "Files", exact: true });
  const origin = list.getByRole("checkbox", { name: "Select a.txt", exact: true });
  await origin.focus();
  await page.keyboard.press("ControlOrMeta+a");
  const selected = list.getByRole("checkbox", { name: /^Select / });
  await expect(selected).toHaveCount(4);
  expect(await selected.evaluateAll((items) => items.every((item) => item.checked))).toBe(
    true,
  );
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog", { name: "Move to trash" })).toBeVisible();
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("desktop-en.png"), fullPage: true });
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(origin).toBeFocused();
});

test("file shortcuts preserve native path and search editing", async ({ page }) => {
  const fixture = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const first = page.getByRole("checkbox", { name: "Select a.txt", exact: true });
  await first.check();
  const path = page.getByLabel("Path", { exact: true });
  await path.fill("native text");
  await path.press("ControlOrMeta+a");
  await path.press("Delete");
  await expect(path).toHaveValue("");
  await expect(first).toBeChecked();
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});

test("row menu receives focus and Escape restores its initiating control", async ({
  page,
}) => {
  await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const trigger = page.getByRole("button", { name: "Actions for a.txt", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Actions for a.txt", exact: true });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("pointer context menus return focus to the row name", async ({ page }) => {
  await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const name = page.getByRole("button", { name: "a.txt", exact: true });
  await name.click({ button: "right" });
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(name).toBeFocused();
});

test("menu action cancellation restores the row action trigger", async ({ page }) => {
  await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const trigger = page.getByRole("button", { name: "Actions for a.txt", exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  const laterCancel = page.getByRole("dialog").getByRole("button", {
    name: "Cancel",
    exact: true,
  });
  await expect(laterCancel).toBeVisible();
  await laterCancel.evaluate(
    (button) =>
      new Promise((resolve) => {
        button.click();
        requestAnimationFrame(() => {
          document.querySelector(".explorer-path-form input").focus();
          resolve();
        });
      }),
  );
  await expect(page.getByLabel("Path", { exact: true })).toBeFocused();
});

test("successful row mutations move focus to a stable list control", async ({ page }) => {
  const fixture = await actionsFixture(page);
  fixture.onStart = (body, job) => {
    fixture.files = fixture.files.filter((entry) => entry.path !== body.sources[0]);
    Object.assign(job, { completedEntries: 0, totalEntries: 1, status: "running" });
  };
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "Actions for a.txt", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move to trash" });
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("button", { name: "a.txt", exact: true })).toHaveCount(0);
  await expect(page.locator(":focus")).toHaveAttribute("type", "checkbox");
});

test("touch selection and the tree drawer remain usable in reduced mobile viewports", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    storageState: `.cache/browser-auth-${new URL(baseURL).port}.json`,
    locale: "de-DE",
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const touchPage = await context.newPage();
  try {
    const fixture = await actionsFixture(touchPage);
    fixture.files.push({
      ...fixture.files[1],
      name: "ein-sehr-langer-dateiname-für-die-mobile-ansicht.txt",
      path: "/home/test/ein-sehr-langer-dateiname-für-die-mobile-ansicht.txt",
    });
    fixture.jobs.set("mobile-running", {
      id: "mobile-running",
      scopeId: "f1:global-fixture",
      kind: "copy",
      status: "running",
      completedEntries: 1,
      totalEntries: 3,
      completedBytes: 1024,
      totalBytes: 4096,
      conflict: null,
    });
    fixture.rows.set("mobile-running", []);
    fixture.jobs.set("mobile-completed", {
      id: "mobile-completed",
      scopeId: "f1:global-fixture",
      kind: "copy",
      status: "completed",
      completedEntries: 1,
      totalEntries: 1,
      completedBytes: 2048,
      totalBytes: 2048,
      conflict: null,
    });
    fixture.rows.set("mobile-completed", [
      {
        id: "result-1",
        source: "/home/test/a.txt",
        path: "/home/test/docs/ein-sehr-langes-transferergebnis.txt",
        status: "completed",
        outputPublished: true,
      },
    ]);
    await touchPage.goto(baseURL + "/files");
    await touchPage.locator('[data-job-id="mobile-completed"] button').first().click();
    await expect(touchPage.getByText(/ein-sehr-langes-transferergebnis/)).toBeVisible();
    await touchPage.setViewportSize({ width: 1440, height: 1000 });
    await touchPage.screenshot({
      path: testInfo.outputPath("desktop-de.png"),
      fullPage: true,
    });
    await touchPage.setViewportSize({ width: 390, height: 844 });
    const checkbox = touchPage.getByRole("checkbox", { name: "a.txt auswählen" });
    await checkbox.tap();
    await expect(checkbox).toBeChecked();
    const tree = touchPage.getByRole("button", { name: "Ordnerbaum öffnen" });
    await tree.tap();
    await expect(touchPage.getByRole("dialog", { name: "Ordnerbaum" })).toBeVisible();
    await touchPage.getByRole("button", { name: "Ordnerbaum schließen" }).click();
    for (const height of [844, 500]) {
      await touchPage.setViewportSize({ width: 390, height });
      expect(
        await touchPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await touchPage.screenshot({
        path: testInfo.outputPath(`mobile-de-390x${height}.png`),
        fullPage: true,
      });
    }
    await selectEnglish(touchPage);
    await touchPage.goto(baseURL + "/files");
    await touchPage.locator('[data-job-id="mobile-completed"] button').first().click();
    for (const height of [844, 500]) {
      await touchPage.setViewportSize({ width: 390, height });
      expect(
        await touchPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await touchPage.screenshot({
        path: testInfo.outputPath(`mobile-en-390x${height}.png`),
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});

test("a tab close uses the retained-draft guard and restores focus after cancellation", async ({
  page,
}) => {
  await explorerFixture(page);
  const path = "/home/test/readme.txt";
  await page.route("**/api/files/text**", (route) =>
    route.fulfill({
      json: {
        path,
        resolvedPath: path,
        text: "original",
        bom: false,
        lineEnding: "lf",
        readOnly: false,
        revision: `d1:${"1".repeat(64)}`,
        metadataRevision: `e1:${"1".repeat(64)}`,
      },
    }),
  );
  await selectEnglish(page);
  await page.goto(
    `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`,
  );
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  await page.getByRole("textbox", { name: `Document content: ${path}` }).fill("draft");
  const close = page.getByRole("button", { name: `Close tab ${path}`, exact: true });
  await close.click();
  await expect(page.getByRole("dialog", { name: "Unsaved documents" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(close).toBeFocused();
  await close.click();
  await expect(page.getByRole("dialog", { name: "Unsaved documents" })).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .evaluate(
      (button) =>
        new Promise((resolve) => {
          button.click();
          requestAnimationFrame(() => {
            document.querySelector(".explorer-path-form input").focus();
            resolve();
          });
        }),
    );
  await expect(page.getByLabel("Path", { exact: true })).toBeFocused();
});

test("mobile editor keeps multiple tabs, a dirty draft, and conflict controls", async ({
  browser,
}, testInfo) => {
  for (const language of ["de", "en"]) {
    const context = await browser.newContext({
      storageState: `.cache/browser-auth-${new URL(baseURL).port}.json`,
      locale: language === "de" ? "de-DE" : "en-US",
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    const mobile = await context.newPage();
    try {
      const fixture = await actionsFixture(mobile);
      const longName = "ein-sehr-langer-mehrtab-dateiname-für-mobile.txt";
      fixture.files.push({
        ...fixture.files[1],
        name: longName,
        path: `/home/test/${longName}`,
      });
      const reads = new Map();
      await mobile.route("**/api/files/text**", async (route) => {
        const request = route.request();
        const selectedPath = new URL(request.url()).searchParams.get("path");
        if (request.method() === "PUT")
          return route.fulfill({
            status: 409,
            json: { code: "FILE_CONFLICT_CHANGED", args: {} },
          });
        const count = (reads.get(selectedPath) || 0) + 1;
        reads.set(selectedPath, count);
        return route.fulfill({
          json: {
            path: selectedPath,
            resolvedPath: selectedPath,
            text: count > 1 ? "external disk" : "original",
            bom: false,
            lineEnding: "lf",
            readOnly: false,
            revision: `d1:${String(Math.min(count, 9)).repeat(64)}`,
            metadataRevision: `e1:${String(Math.min(count, 9)).repeat(64)}`,
          },
        });
      });
      await mobile.goto(baseURL + "/settings");
      await mobile.getByLabel(/Sprache|Language/).selectOption(language);
      await mobile.goto(baseURL + "/files");
      await mobile.getByRole("button", { name: longName, exact: true }).click();
      await mobile
        .getByRole("button", {
          name: language === "en" ? "Open in editor" : "Im Editor öffnen",
          exact: true,
        })
        .tap();
      const firstPath = "/home/test/a.txt";
      await mobile.getByRole("button", { name: "a.txt", exact: true }).click();
      await mobile
        .getByRole("button", {
          name: language === "en" ? "Open in editor" : "Im Editor öffnen",
          exact: true,
        })
        .tap();
      await mobile
        .getByRole("textbox", { name: new RegExp(firstPath) })
        .fill("local dirty draft");
      await expect(mobile.getByRole("tab")).toHaveCount(2);
      const closeButtons = mobile.locator(".file-editor-tab-close");
      await expect(closeButtons).toHaveCount(2);
      for (const closeButton of await closeButtons.all()) {
        await closeButton.scrollIntoViewIfNeeded();
        const box = await closeButton.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(40);
        expect(box.height).toBeGreaterThanOrEqual(40);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
      }
      await mobile.getByRole("tab").filter({ hasText: firstPath }).tap();
      await mobile
        .getByRole("button", {
          name: language === "en" ? "Save" : "Speichern",
          exact: true,
        })
        .tap();
      await expect(
        mobile.getByRole("region", {
          name: language === "en" ? "Conflict comparison" : "Konfliktvergleich",
        }),
      ).toBeVisible();
      for (const height of [844, 500]) {
        await mobile.setViewportSize({ width: 390, height });
        expect(
          await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        await mobile.screenshot({
          path: testInfo.outputPath(`editor-conflict-${language}-390x${height}.png`),
          fullPage: true,
        });
        await mobile
          .getByRole("region", {
            name: language === "en" ? "Conflict comparison" : "Konfliktvergleich",
          })
          .scrollIntoViewIfNeeded();
        await mobile.screenshot({
          path: testInfo.outputPath(
            `editor-conflict-viewport-${language}-390x${height}.png`,
          ),
        });
      }
      await mobile
        .getByRole("button", {
          name:
            language === "en" ? "Continue manual resolution" : "Manuell weiter auflösen",
          exact: true,
        })
        .tap();
      await expect(
        mobile.getByRole("region", { name: /Konfliktvergleich|Conflict comparison/ }),
      ).toHaveCount(0);
      await mobile
        .getByRole("button", {
          name:
            language === "en" ? `Close tab ${firstPath}` : `Tab ${firstPath} schließen`,
          exact: true,
        })
        .tap();
      await mobile
        .getByRole("button", {
          name: language === "en" ? "Discard and continue" : "Verwerfen und fortfahren",
          exact: true,
        })
        .tap();
      await expect(mobile.getByRole("tab")).toHaveCount(1);
      await mobile.screenshot({
        path: testInfo.outputPath(`editor-tab-close-${language}-390x500.png`),
      });
    } finally {
      await context.close();
    }
  }
});

test("active upload controls remain reachable in compact touch viewports", async ({
  browser,
}, testInfo) => {
  for (const language of ["de", "en"]) {
    const context = await browser.newContext({
      storageState: `.cache/browser-auth-${new URL(baseURL).port}.json`,
      locale: language === "de" ? "de-DE" : "en-US",
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    const mobile = await context.newPage();
    try {
      const { state } = await uploadsFixture(mobile);
      const group = state.seed([
        {
          id: "active-file",
          relativePath: "ein-sehr-langer-aktiver-uploadname.txt",
          path: "/home/test/ein-sehr-langer-aktiver-uploadname.txt",
          type: "file",
          bytes: 4096,
          status: "running",
        },
      ]);
      state.child(group, "active-file", { status: "running" });
      await mobile.goto(baseURL + "/settings");
      await mobile.getByLabel(/Sprache|Language/).selectOption(language);
      await mobile.goto(baseURL + "/files");
      await mobile.locator(".file-upload-history summary").click();
      await mobile.locator(".file-upload-history li button").first().click();
      await expect(
        mobile.getByText("ein-sehr-langer-aktiver-uploadname.txt", { exact: true }),
      ).toBeVisible();
      for (const height of [844, 500]) {
        await mobile.setViewportSize({ width: 390, height });
        expect(
          await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        await mobile.screenshot({
          path: testInfo.outputPath(`active-upload-${language}-390x${height}.png`),
          fullPage: true,
        });
      }
      const cancel = mobile.getByRole("button", {
        name: new RegExp(
          language === "en"
            ? "Cancel ein-sehr-langer-aktiver-uploadname"
            : "ein-sehr-langer-aktiver-uploadname.*abbrechen",
          "i",
        ),
      });
      await cancel.scrollIntoViewIfNeeded();
      await mobile.screenshot({
        path: testInfo.outputPath(`active-upload-viewport-${language}-390x500.png`),
      });
      await cancel.tap();
      await expect
        .poll(() => state.requests.some((request) => request.suffix.endsWith("/cancel")))
        .toBe(true);
    } finally {
      await context.close();
    }
  }
});

test("file shortcuts do not intercept CodeMirror editing", async ({ page }) => {
  const fixture = await actionsFixture(page);
  const path = "/home/test/a.txt";
  await page.route("**/api/files/text**", (route) =>
    route.fulfill({
      json: {
        path,
        resolvedPath: path,
        text: "original",
        bom: false,
        lineEnding: "lf",
        readOnly: false,
        revision: `d1:${"2".repeat(64)}`,
        metadataRevision: `e1:${"2".repeat(64)}`,
      },
    }),
  );
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const selected = page.getByRole("checkbox", { name: "Select b.txt", exact: true });
  await selected.check();
  await page.getByRole("button", { name: "a.txt", exact: true }).click();
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const editor = page.getByRole("textbox", { name: `Document content: ${path}` });
  await editor.fill("keep this");
  await editor.press("ControlOrMeta+a");
  await editor.press("Delete");
  await expect(editor).toHaveText("");
  await expect(selected).toBeChecked();
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});
