import { test, expect } from "@playwright/test";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";
import { navigateTo } from "../helpers/navigation.js";

const path = "/home/test/readme.txt";
const editorURL = `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`;
const document = {
  path,
  resolvedPath: path,
  text: "original",
  bom: false,
  lineEnding: "lf",
  revision: `d1:${"1".repeat(64)}`,
  metadataRevision: `e1:${"1".repeat(64)}`,
  readOnly: false,
};

async function setup(page, { english = true, saveError = null } = {}) {
  await explorerFixture(page);
  await page.route("**/api/files/text**", async (route) => {
    const selected = new URL(route.request().url()).searchParams.get("path");
    if (route.request().method() === "PUT") {
      if (saveError)
        return route.fulfill({
          status: saveError.status,
          json: { code: saveError.code, args: {} },
        });
      return route.fulfill({
        json: {
          path: selected,
          revision: `d1:${"2".repeat(64)}`,
          metadataRevision: `e1:${"2".repeat(64)}`,
        },
      });
    }
    await route.fulfill({
      json: { ...document, path: selected, resolvedPath: selected },
    });
  });
  if (english) await selectEnglish(page);
  await page.goto(editorURL);
  await page
    .getByRole("button", {
      name: english ? "Open in editor" : "Im Editor öffnen",
      exact: true,
    })
    .click();
  const editor = page.getByRole("textbox", {
    name: english ? `Document content: ${path}` : `Dokumentinhalt: ${path}`,
  });
  await editor.fill("draft");
  return editor;
}

test("cancelled application navigation preserves the route and draft", async ({
  page,
}, testInfo) => {
  const editor = await setup(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("guard-english-desktop.png") });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(editorURL);
  await expect(editor).toHaveText("draft");
});

test("German mobile guard preserves the draft on cancellation", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = await setup(page, { english: false });
  await navigateTo(page, "Einstellungen");
  await expect(
    page.getByRole("heading", { name: "Ungespeicherte Dokumente" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("guard-german-mobile.png") });
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(editor).toHaveText("draft");
});

test("discard accepts navigation and closes the protected tab", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Discard and continue", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/settings`);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("saving a changed draft resolves navigation before committing", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/settings`);
});

test("failed endpoint-mocked save keeps navigation blocked and the draft retained", async ({
  page,
}) => {
  const editor = await setup(page, {
    saveError: { status: 409, code: "FILE_INVALID_SCOPE" },
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page).toHaveURL(editorURL);
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await expect(editor).toHaveText("draft");
});

test("Back restores the indexed route once while the guard decides", async ({ page }) => {
  const editor = await setup(page);
  await editor.fill("original");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await editor.fill("draft after history");
  const committedURL = page.url();
  await page.goBack({ waitUntil: "commit" }).catch(() => {});
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(committedURL);
  await expect(editor).toHaveText("draft after history");
});

test("navigation index preserves unrelated history state", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => history.replaceState({ foreign: "keep" }, ""));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Discard and continue", exact: true }).click();
  expect(await page.evaluate(() => history.state.foreign)).toBe("keep");
  expect(await page.evaluate(() => history.state.agentPierNavigationIndex)).toBe(1);
});

test("navigation rechecks an earlier tab protected during a later decision", async ({
  page,
}) => {
  const first = await setup(page);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const secondPath = "/home/test/second.txt";
  await page.evaluate(
    (next) => {
      history.pushState(null, "", next);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    `/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(secondPath)}`,
  );
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const second = page.getByRole("textbox", {
    name: `Document content: ${secondPath}`,
  });
  await second.fill("second draft");
  await page.getByRole("tab", { name: path, exact: true }).click();
  await first.fill("first draft again");
  const committedURL = page.url();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.getByRole("tab", { name: path, exact: true }).click({ force: true });
  await page.getByLabel("Line ending").selectOption("crlf", { force: true });
  await page.getByRole("button", { name: "Discard and continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await expect(page.getByLabel("Line ending")).toHaveValue("crlf");
  await expect(first).toHaveText("first draft again");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(committedURL);
});

test("beforeunload registration follows protected editor state", async ({ page }) => {
  await page.addInitScript(() => {
    window.__unloadListeners = { added: 0, removed: 0 };
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === "beforeunload") window.__unloadListeners.added++;
      return add(type, listener, options);
    };
    window.removeEventListener = (type, listener, options) => {
      if (type === "beforeunload") window.__unloadListeners.removed++;
      return remove(type, listener, options);
    };
  });
  const editor = await setup(page);
  await expect.poll(() => page.evaluate(() => window.__unloadListeners.added)).toBe(1);
  await editor.fill("original");
  await expect.poll(() => page.evaluate(() => window.__unloadListeners.removed)).toBe(1);
});
