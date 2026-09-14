import { test, expect } from "@playwright/test";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { baseURL } from "../helpers/browser.js";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { uploadsFixture } from "../helpers/file-uploads-browser.js";

const source = (name) => ({
  name,
  mimeType: "application/octet-stream",
  buffer: Buffer.from(name),
});

async function tabTo(page, locator, limit = 160) {
  const key =
    page.context().browser()?.browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
  for (let step = 0; step < limit; step++) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Tab did not reach ${await locator.getAttribute("aria-label")}`);
}

test("Trash shortcuts own only the visible Trash selection", async ({ page }) => {
  const fixture = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const hiddenFile = page.getByRole("checkbox", { name: "Select a.txt", exact: true });
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const trashItem = page.getByRole("checkbox", {
    name: "Select report.txt",
    exact: true,
  });
  await trashItem.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(trashItem).toBeChecked();
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "File list", exact: true }).click();
  await expect(hiddenFile).not.toBeChecked();
  await expect(page.getByRole("dialog", { name: "Move to trash" })).toHaveCount(0);
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});

test("accepted last-tab close restores the surviving open control", async ({ page }) => {
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
  const open = page.getByRole("button", { name: "Open in editor", exact: true });
  await open.click();
  await page.getByRole("button", { name: `Close tab ${path}`, exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");
  await page
    .getByRole("textbox", { name: `Document content: ${path}` })
    .fill("retained draft");
  await page.getByRole("button", { name: `Close tab ${path}`, exact: true }).click();
  await page.getByRole("button", { name: "Discard and continue", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(open).toBeFocused();
});

for (const language of ["en", "de"])
  test(`keyboard-only explorer ownership and commands remain explicit in ${language}`, async ({
    page,
  }) => {
    const fixture = await actionsFixture(page);
    await page.goto(baseURL + "/settings");
    await page.getByLabel(/Sprache|Language/).selectOption(language);
    await page.goto(baseURL + "/files");
    const labels =
      language === "en"
        ? {
            select: "Select a.txt",
            menu: "Actions for a.txt",
            expand: "Expand /",
            collapse: "Collapse /",
            move: "Move",
            rename: "Rename",
            trash: "Move to Trash",
            copy: "Copy",
            cut: "Cut",
            cancel: "Cancel",
          }
        : {
            select: "a.txt auswählen",
            menu: "Aktionen für a.txt",
            expand: "/ aufklappen",
            collapse: "/ zuklappen",
            move: "Verschieben",
            rename: "Umbenennen",
            trash: "In den Papierkorb",
            copy: "Kopieren",
            cut: "Ausschneiden",
            cancel: "Abbrechen",
          };
    const outside = page.locator(".brand");
    await tabTo(page, outside);
    await expect(outside).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(
      0,
    );

    const expand = page.getByRole("button", { name: labels.expand, exact: true });
    await tabTo(page, expand);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: labels.collapse, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(expand).toBeFocused();

    const checkbox = page.getByRole("checkbox", { name: labels.select, exact: true });
    await tabTo(page, checkbox);
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await page.keyboard.press("ControlOrMeta+a");
    expect(
      await page
        .locator(".explorer-list .file-selection-checkbox")
        .evaluateAll((items) => items.every((item) => item.checked)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(checkbox).not.toBeChecked();
    await page.keyboard.press("Space");
    await page.keyboard.press("ControlOrMeta+c");
    await expect(page.getByRole("status")).toContainText(/clipboard|Zwischenablage/i);
    await page.keyboard.press("ControlOrMeta+x");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(
      page.getByRole("dialog", { name: labels.move, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(checkbox).toBeFocused();
    await page.keyboard.press("F2");
    await expect(
      page.getByRole("dialog", { name: labels.rename, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(checkbox).toBeFocused();
    await page.keyboard.press("Delete");
    await expect(
      page.getByRole("dialog", { name: labels.trash, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const menuTrigger = page.getByRole("button", { name: labels.menu, exact: true });
    await tabTo(page, menuTrigger);
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitem", { name: labels.cancel, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Home");
    await expect(
      page.getByRole("menuitem", { name: labels.copy, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: labels.cut, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menuTrigger).toBeFocused();

    const name = page.getByRole("button", { name: "a.txt", exact: true });
    await tabTo(page, name);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/file=%2Fhome%2Ftest%2Fa\.txt/);
    expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(
      0,
    );
  });

test("compact touch controls cover multiselect tree favorite menu and confirmation", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    storageState: `.cache/browser-auth-${new URL(baseURL).port}.json`,
    locale: "de-DE",
    hasTouch: true,
    viewport: { width: 390, height: 500 },
  });
  const page = await context.newPage();
  try {
    const fixture = await actionsFixture(page);
    const inaccessiblePath = "/missing/mobile-favorite";
    const inaccessibleRequests = [];
    await page.route("**/api/files/preferences", async (route) => {
      if (route.request().method() === "PATCH")
        return route.fulfill({ json: { favorites: [], showHidden: false } });
      return route.fulfill({
        json: {
          favorites: [{ id: "mobile-favorite", name: "Mobil", path: inaccessiblePath }],
          showHidden: false,
        },
      });
    });
    await page.route("**/api/files/**", async (route) => {
      const url = new URL(route.request().url());
      if (
        ["/api/files/entries", "/api/files/metadata"].includes(url.pathname) &&
        url.searchParams.get("path") === inaccessiblePath
      ) {
        inaccessibleRequests.push(url.pathname);
        return route.fulfill({ status: 404, json: { code: "FILE_NOT_FOUND" } });
      }
      return route.fallback();
    });
    await page.goto(baseURL + "/files");
    await page.getByRole("checkbox", { name: "a.txt auswählen" }).tap();
    await page.getByRole("checkbox", { name: "b.txt auswählen" }).tap();
    await expect(
      page.locator(".explorer-list .file-selection-checkbox:checked"),
    ).toHaveCount(2);
    await page.getByRole("button", { name: "Aktionen für a.txt" }).tap();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.getByRole("menuitem", { name: "Abbrechen", exact: true }).tap();
    await page.getByRole("button", { name: "Ordnerbaum öffnen" }).tap();
    const expand = page.getByRole("button", { name: "/ aufklappen", exact: true });
    await expand.tap();
    await expect(page.getByRole("button", { name: "/ zuklappen" })).toBeVisible();
    await page.getByRole("button", { name: "/ zuklappen" }).tap();
    const filesURL = page.url();
    await page.getByRole("button", { name: "Favorit Mobil entfernen" }).tap();
    await expect(
      page.getByRole("button", { name: "Favorit Mobil entfernen" }),
    ).toHaveCount(0);
    expect(inaccessibleRequests).toEqual([]);
    expect(page.url()).toBe(filesURL);
    await page.getByRole("button", { name: "Ordnerbaum schließen" }).tap();
    await page.getByRole("button", { name: "In den Papierkorb", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "In den Papierkorb" });
    await dialog.getByRole("button", { name: "Bestätigen", exact: true }).tap();
    await expect
      .poll(() => fixture.requests.filter((item) => item.method === "POST").length)
      .toBe(1);
    await page.screenshot({ path: testInfo.outputPath("touch-de-390x500.png") });
  } finally {
    await context.close();
  }
});

test("compact touch retry sends a fresh upload attempt", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    storageState: `.cache/browser-auth-${new URL(baseURL).port}.json`,
    locale: "en-US",
    hasTouch: true,
    viewport: { width: 390, height: 500 },
  });
  const page = await context.newPage();
  try {
    const { state } = await uploadsFixture(page);
    state.failures.add("retry-touch.txt");
    await page.goto(baseURL + "/settings");
    await page.getByLabel(/Sprache|Language/).selectOption("en");
    await page.goto(baseURL + "/files");
    await page
      .getByLabel("Upload files", { exact: true })
      .setInputFiles(source("retry-touch.txt"));
    const retry = page.getByRole("button", {
      name: "Retry retry-touch.txt",
      exact: true,
    });
    await expect(retry).toBeVisible();
    await retry.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("touch-retry-en-390x500.png") });
    await retry.tap();
    await expect.poll(() => state.raw.length).toBe(2);
  } finally {
    await context.close();
  }
});

test("editor search merge and Save As controls retain native keyboard ownership", async ({
  page,
}) => {
  const fixture = await actionsFixture(page);
  const path = "/home/test/a.txt";
  let reads = 0;
  await page.route("**/api/files/text**", async (route) => {
    if (route.request().method() === "PUT")
      return route.fulfill({
        status: 409,
        json: { code: "FILE_CONFLICT_CHANGED", args: {} },
      });
    reads++;
    return route.fulfill({
      json: {
        path,
        resolvedPath: path,
        text: reads === 1 ? "original searchable text" : "external disk text",
        bom: false,
        lineEnding: "lf",
        readOnly: false,
        revision: `d1:${String(reads).repeat(64)}`,
        metadataRevision: `e1:${String(reads).repeat(64)}`,
      },
    });
  });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const selected = page.getByRole("checkbox", { name: "Select b.txt", exact: true });
  await selected.check();
  const filenameSearch = page.getByLabel("Filename search", { exact: true });
  await tabTo(page, filenameSearch);
  await page.keyboard.type("native filename");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+x");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(filenameSearch).toHaveValue("native filename");
  await expect(selected).toBeChecked();

  await page.getByRole("button", { name: "a.txt", exact: true }).click();
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const saveAs = page.getByLabel("Save As path", { exact: true });
  await tabTo(page, saveAs);
  await page.keyboard.type("/home/test/native-copy.txt");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+x");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(saveAs).toHaveValue("/home/test/native-copy.txt");
  await page.getByRole("button", { name: "Search and replace", exact: true }).click();
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await tabTo(page, find);
  await page.keyboard.type("searchable");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+x");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(find).toHaveValue("searchable");

  const editor = page.getByRole("textbox", { name: `Document content: ${path}` });
  await editor.fill("local conflict draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const merge = page.locator(".cm-mergeView .cm-content").first();
  await merge.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.getByRole("region", { name: "Conflict comparison" })).toBeVisible();
  await expect(selected).toBeChecked();
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});
