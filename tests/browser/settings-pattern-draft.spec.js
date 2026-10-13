import { test, expect } from "@playwright/test";
import { startSettingsHarness } from "../helpers/settings-pattern-harness.js";

test.describe.configure({ timeout: 90000 });
let harness;
test.beforeAll(async () => {
  harness = await startSettingsHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
const open = (page, lang = "de") =>
  page.goto(`${harness.url}?fixture=draft&lang=${lang}`);
const bar = (page, name = "Ungespeicherte Änderungen") =>
  page.getByRole("region", { name });
const server = async (page) => JSON.parse(await page.getByTestId("server").textContent());
const harnessState = (page) => page.evaluate(() => window.harness);

test("the bar appears only while dirty and cancel restores the server value", async ({
  page,
}) => {
  await open(page);
  await expect(bar(page)).toHaveCount(0);
  await page.getByLabel("Name").fill("Office");
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toContainText("Startet 2 Agenten kurz neu.");
  const save = bar(page).getByRole("button", { name: "Speichern" });
  expect(Math.round((await save.boundingBox()).height)).toBe(40);
  await bar(page).getByRole("button", { name: "Abbrechen" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel("Name")).toHaveValue("Home");
});

test("a failed second step reports the partial save and a retry skips the first", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.harness.failTeam = true;
  });
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("spinbutton", { name: "Mitglieder" }).fill("6");
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page).getByRole("alert")).toContainText(
    "Teilweise gespeichert: Profil.",
  );
  await expect(bar(page).getByRole("alert")).toContainText(
    "Team konnte nicht gespeichert werden.",
  );
  expect((await server(page)).name).toBe("Office");
  expect((await server(page)).maxMembers).toBe(4);
  await page.evaluate(() => {
    window.harness.failTeam = false;
  });
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect((await server(page)).maxMembers).toBe(6);
  expect((await harnessState(page)).calls).toMatchObject({ agent: 1, team: 2 });
});

test("a cancelled confirmation after a saved step reports the partial save", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.harness.restartTeam = true;
  });
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("spinbutton", { name: "Mitglieder" }).fill("6");
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  const sheet = page.getByRole("dialog", { name: "Neustart bestätigen" });
  await sheet.getByRole("button", { name: "Abbrechen" }).click();
  await expect(bar(page).getByRole("alert")).toHaveText("Teilweise gespeichert: Profil.");
  expect((await server(page)).name).toBe("Office");
  await page.evaluate(() => {
    window.harness.restartTeam = false;
  });
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect((await server(page)).maxMembers).toBe(6);
  expect((await harnessState(page)).calls).toMatchObject({ agent: 1, team: 2 });
});

test("a confirmation opens a sheet and the step repeats with the flag", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.harness.restart = true;
  });
  await page.getByRole("switch", { name: "Gedächtnis" }).check();
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  const sheet = page.getByRole("dialog", { name: "Neustart bestätigen" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Abbrechen" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(bar(page).getByRole("alert")).toHaveCount(0);
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await page
    .getByRole("dialog", { name: "Neustart bestätigen" })
    .getByRole("button", { name: "Neu starten" })
    .click();
  await expect(bar(page)).toHaveCount(0);
  expect((await server(page)).memory).toBe(true);
});

test("a foreign change is adopted where untouched and overwriting keeps it", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.evaluate(() => window.harness.foreignChange());
  await expect(page.getByRole("switch", { name: "Gedächtnis" })).toBeChecked();
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page).getByRole("alert")).toContainText(
    "Inzwischen an anderer Stelle geändert.",
  );
  await bar(page).getByRole("button", { name: "Trotzdem überschreiben" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect(await server(page)).toMatchObject({ name: "Office", memory: true, revision: 3 });
});

test("a save adopts the value the server stored", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.harness.trimName = true;
  });
  await page.getByLabel("Name").fill("  Office ");
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel("Name")).toHaveValue("Office");
  expect((await server(page)).name).toBe("Office");
  await page.evaluate(() => window.harness.foreignChange());
  await expect(page.getByRole("switch", { name: "Gedächtnis" })).toBeChecked();
  await expect(page.getByLabel("Name")).toHaveValue("Office");
  await expect(bar(page)).toHaveCount(0);
});

test("a change the page only learns through refresh can be overwritten", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.evaluate(() => window.harness.hiddenChange());
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page).getByRole("alert")).toContainText(
    "Inzwischen an anderer Stelle geändert.",
  );
  await expect(page.getByRole("switch", { name: "Gedächtnis" })).toBeChecked();
  await bar(page).getByRole("button", { name: "Trotzdem überschreiben" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect(await server(page)).toMatchObject({ name: "Office", memory: true, revision: 3 });
});

test("reload after a hidden change restores the refreshed record", async ({ page }) => {
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.evaluate(() => window.harness.hiddenChange());
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await bar(page).getByRole("button", { name: "Neu laden" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel("Name")).toHaveValue("Home");
  await expect(page.getByRole("switch", { name: "Gedächtnis" })).toBeChecked();
  await page.getByLabel("Name").fill("Studio");
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect((await server(page)).name).toBe("Studio");
});

test("Escape does not cancel a running save and switch", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.harness.delay = 600;
  });
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("tab", { name: "Team" }).click();
  const sheet = page.getByRole("dialog", { name: "Änderungen speichern?" });
  await sheet.getByRole("button", { name: "Speichern und wechseln" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tab")).toHaveText("team");
  expect((await server(page)).name).toBe("Office");
});

test("reload after a conflict drops the edit", async ({ page }) => {
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.evaluate(() => window.harness.foreignChange());
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await bar(page).getByRole("button", { name: "Neu laden" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel("Name")).toHaveValue("Home");
});

test("switching tabs with unsaved changes asks first", async ({ page }) => {
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("tab", { name: "Team" }).click();
  const sheet = page.getByRole("dialog", { name: "Änderungen speichern?" });
  await expect(sheet).toContainText(
    "Im Tab Profil ist 1 Änderung noch nicht gespeichert.",
  );
  await sheet.getByRole("button", { name: "Abbrechen" }).click();
  await expect(page.getByTestId("tab")).toHaveText("profile");
  await page.getByRole("tab", { name: "Team" }).click();
  await sheet.getByRole("button", { name: "Verwerfen" }).click();
  await expect(page.getByTestId("tab")).toHaveText("team");
  await expect(page.getByLabel("Name")).toHaveValue("Home");
  await page.getByRole("tab", { name: "Profil" }).click();
  await expect(page.getByTestId("tab")).toHaveText("profile");
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("tab", { name: "Team" }).click();
  await sheet.getByRole("button", { name: "Speichern und wechseln" }).click();
  await expect(page.getByTestId("tab")).toHaveText("team");
  expect((await server(page)).name).toBe("Office");
});

test("the unload warning is held only while the draft is dirty", async ({ page }) => {
  await page.addInitScript(() => {
    window.__unload = { added: 0, removed: 0 };
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === "beforeunload") window.__unload.added++;
      return add(type, listener, options);
    };
    window.removeEventListener = (type, listener, options) => {
      if (type === "beforeunload") window.__unload.removed++;
      return remove(type, listener, options);
    };
  });
  await open(page);
  // The dev server's client may listen itself; only the draft's changes count.
  const before = await page.evaluate(() => ({ ...window.__unload }));
  await page.getByLabel("Name").fill("Office");
  await page.getByLabel("Name").fill("Office 2");
  await expect
    .poll(() => page.evaluate(() => window.__unload.added))
    .toBe(before.added + 1);
  await bar(page).getByRole("button", { name: "Abbrechen" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__unload.removed))
    .toBe(before.removed + 1);
});

test("English copy and the phone bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "en");
  await page.getByLabel("Name").fill("Office");
  await expect(
    bar(page, "Unsaved changes").getByRole("button", { name: "Save" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Team" }).click();
  const sheet = page.getByRole("dialog", { name: "Save changes?" });
  await expect(sheet).toContainText("1 change in Profil is not saved yet.");
  const box = await sheet.boundingBox();
  expect(Math.round(box.y + box.height)).toBe(844);
  await expect(sheet.getByRole("button", { name: "Save and switch" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("tab")).toHaveText("profile");
});

test("the desktop sheet is a centred dialog of at most 420px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("tab", { name: "Team" }).click();
  const box = await page
    .getByRole("dialog", { name: "Änderungen speichern?" })
    .boundingBox();
  expect(box.width).toBeLessThanOrEqual(420);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(2);
});
