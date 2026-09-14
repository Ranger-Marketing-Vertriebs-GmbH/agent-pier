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
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function setup(page, { english = true, saveError = null, saveGate = null } = {}) {
  await explorerFixture(page);
  await page.route("**/api/files/text**", async (route) => {
    const selected = new URL(route.request().url()).searchParams.get("path");
    if (route.request().method() === "PUT") {
      if (saveGate) await saveGate.promise;
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

test("Escape cannot cancel a decision while its save completion is pending", async ({
  page,
}) => {
  const saveGate = deferred();
  await setup(page, { saveGate });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  saveGate.resolve();
  await expect(page).toHaveURL(`${baseURL}/settings`);
});

test("an obsolete save continuation cannot resolve a newer navigation decision", async ({
  page,
}) => {
  const saveGate = deferred();
  const first = await setup(page, { saveGate });
  await first.fill("original");
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
  await first.fill("first draft");
  await expect(first).toHaveText("first draft");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Accounts"))
      ?.click();
  });
  saveGate.resolve();
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.getByRole("button", { name: "Discard and continue", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/accounts`);
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

test("accepted Back replays once to the indexed route", async ({ page }) => {
  const editor = await setup(page);
  await editor.fill("original");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const targetURL = page.url();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await editor.fill("history draft");
  await page.goBack({ waitUntil: "commit" }).catch(() => {});
  await page.getByRole("button", { name: "Discard and continue", exact: true }).click();
  await expect(page).toHaveURL(targetURL);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
});

test("application navigation during history replay reconciles before push", async ({
  page,
}) => {
  const editor = await setup(page);
  await editor.fill("original");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(/\/files\?path=/);
  await editor.fill("interleaved draft");
  const committedURL = page.url();
  await page.goBack({ waitUntil: "commit" }).catch(() => {});
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.find((button) => button.textContent === "Discard and continue")?.click();
    setTimeout(
      () => buttons.find((button) => button.textContent.includes("Accounts"))?.click(),
      0,
    );
  });
  await expect(page).toHaveURL(`${baseURL}/accounts`);
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(committedURL);
  expect(await page.evaluate(() => history.state.agentPierNavigationIndex)).toBe(2);
});

test("rapid Back Back keeps the latest indexed intent and cancellation restores once", async ({
  page,
}) => {
  const editor = await setup(page);
  await editor.fill("original");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await editor.fill("rapid draft");
  const current = {
    url: page.url(),
    length: await page.evaluate(() => history.length),
    index: await page.evaluate(() => history.state.agentPierNavigationIndex),
  };
  await page.evaluate(() => {
    history.back();
    history.back();
  });
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(current.url);
  expect(await page.evaluate(() => history.length)).toBe(current.length);
  expect(await page.evaluate(() => history.state.agentPierNavigationIndex)).toBe(
    current.index,
  );
});

test("rapid Back Forward returns to the current indexed entry without a stale commit", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__forwardAfterBack = false;
    addEventListener("popstate", () => {
      if (!window.__forwardAfterBack) return;
      window.__forwardAfterBack = false;
      setTimeout(() => history.forward(), 0);
    });
  });
  const editor = await setup(page);
  await editor.fill("original");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(/\/files\?path=/);
  await editor.fill("forward draft");
  const current = {
    url: page.url(),
    length: await page.evaluate(() => history.length),
    index: await page.evaluate(() => history.state.agentPierNavigationIndex),
  };
  await page.evaluate(() => {
    window.__forwardAfterBack = true;
    history.back();
  });
  await expect(page).toHaveURL(current.url);
  await expect(editor).toHaveText("forward draft");
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => history.length)).toBe(current.length);
  expect(await page.evaluate(() => history.state.agentPierNavigationIndex)).toBe(
    current.index,
  );
});

test("navigation index preserves unrelated history state", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => history.replaceState({ foreign: "keep" }, ""));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Discard and continue", exact: true }).click();
  expect(await page.evaluate(() => history.state.foreign)).toBe("keep");
  expect(await page.evaluate(() => history.state.agentPierNavigationIndex)).toBe(1);
});

test("cancelled unindexed history preserves length, foreign state and the draft", async ({
  page,
}) => {
  const editor = await setup(page);
  const currentURL = page.url();
  const length = await page.evaluate(() => history.length);
  await page.evaluate(() => {
    history.pushState({ foreign: "unindexed" }, "", "/accounts");
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await expect(page.getByRole("heading", { name: "Unsaved documents" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(currentURL);
  await expect(editor).toHaveText("draft");
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  expect(await page.evaluate(() => history.state.foreign)).toBe("unindexed");
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
