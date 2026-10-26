import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsBar, settingsRow } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

const calls = (state, method, path) =>
  state.calls.filter((call) => call.method === method && call.path === path);
async function featureRoute(page) {
  const feature = { puts: [], fail: false, answer: { enabled: false, error: null } };
  await page.route("**/api/assistant-feature", async (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({ json: { enabled: false, error: null } });
    feature.puts.push(route.request().postDataJSON());
    if (feature.fail)
      return route.fulfill({ status: 500, json: { error: "Feature fixture failure" } });
    return route.fulfill({ json: feature.answer });
  });
  return feature;
}

for (const locale of ["de-DE", "en-GB"]) {
  const en = locale === "en-GB";
  const t = (german, english) => (en ? english : german);
  const resume = t(
    "Unterbrochene Sessions automatisch fortsetzen",
    "Resume interrupted sessions automatically",
  );
  test.describe(`settings workspace ${locale}`, () => {
    test.use({ locale });

    test("the bar appears only with changes and cancel restores them", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      const toggle = page.getByRole("switch", { name: resume });
      await expect(toggle).toBeChecked();
      await expect(settingsBar(page)).toHaveCount(0);
      await toggle.click();
      await expect(
        settingsBar(page).getByRole("button", {
          name: t("Einstellungen speichern", "Save settings"),
          exact: true,
        }),
      ).toBeVisible();
      await settingsBar(page)
        .getByRole("button", { name: t("Abbrechen", "Cancel"), exact: true })
        .click();
      await expect(settingsBar(page)).toHaveCount(0);
      await expect(toggle).toBeChecked();
      expect(calls(state, "PATCH", "/preferences")).toEqual([]);
    });

    test("switching tabs with changes asks first", async ({ page }) => {
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      const toggle = page.getByRole("switch", { name: resume });
      await toggle.click();
      // The Access tab moved to Zugänge; Operations is a settings tab of its own.
      const operations = page.getByRole("tab", { name: t("Betrieb", "Operations") });
      await operations.click();
      const sheet = page.getByRole("dialog", {
        name: t("Änderungen speichern?", "Save changes?"),
      });
      await expect(sheet).toContainText(
        t(
          "Im Tab Allgemein ist 1 Änderung noch nicht gespeichert.",
          "1 change in General is not saved yet.",
        ),
      );
      await sheet
        .getByRole("button", { name: t("Abbrechen", "Cancel"), exact: true })
        .click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(toggle).not.toBeChecked();
      await operations.click();
      await sheet
        .getByRole("button", { name: t("Verwerfen", "Discard"), exact: true })
        .click();
      await expect(page).toHaveURL(/\/settings\?tab=operations$/);
      await page.getByRole("tab", { name: t("Allgemein", "General") }).click();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await page.getByRole("tab", { name: t("Betrieb", "Operations") }).click();
      await sheet
        .getByRole("button", {
          name: t("Speichern und wechseln", "Save and switch"),
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/settings\?tab=operations$/);
      expect(calls(state, "PATCH", "/preferences").map((call) => call.body)).toEqual([
        { autoResumeInterrupted: false },
      ]);
    });
  });
}

test("a save sends only changed fields and canonical directories stay clean", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  await page.route("**/api/preferences", async (route) => {
    const body = route.request().postDataJSON();
    state.calls.push({ path: "/preferences", method: "PATCH", body });
    state.preferences = {
      ...state.preferences,
      ...body,
      ...(body.defaultCwd ? { defaultCwd: "/fixture/canonical" } : {}),
    };
    // Let the 3s state poll publish the canonical directory while the save still
    // runs: the draft sees it as a foreign change and must still end clean.
    const statePolls = () => state.calls.filter((call) => call.path === "/state").length;
    const before = statePolls();
    while (statePolls() === before)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      json: { defaultCwd: "/fixture", autoResumeInterrupted: true, ...state.preferences },
    });
  });
  await page.goto(baseURL + "/settings");
  const directory = page.getByLabel("Standard-Arbeitsverzeichnis", { exact: true });
  await expect(directory).toHaveValue("/fixture");
  await directory.fill("~/work");
  await settingsBar(page)
    .getByRole("button", { name: "Einstellungen speichern", exact: true })
    .click();
  await expect(directory).toHaveValue("/fixture/canonical");
  await expect(settingsBar(page)).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Einstellungen gespeichert.");
  expect(calls(state, "PATCH", "/preferences").map((call) => call.body)).toEqual([
    { defaultCwd: "~/work" },
  ]);
});

test("a failed second step keeps the tab dirty and a retry skips the first", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  await featureRoute(page);
  let failures = 1;
  await page.route("**/api/preferences", (route) =>
    route.request().method() === "PATCH" && failures-- > 0
      ? route.fulfill({ status: 500, json: { error: "Preferences fixture failure" } })
      : route.fallback(),
  );
  await page.goto(baseURL + "/settings");
  const resume = page.getByRole("switch", {
    name: "Unterbrochene Sessions automatisch fortsetzen",
  });
  await resume.click();
  await page.getByRole("combobox", { name: "Sprache" }).selectOption("en");
  const bar = settingsBar(page);
  await bar.getByRole("button", { name: "Einstellungen speichern", exact: true }).click();
  await expect(bar.getByRole("alert")).toContainText("Partially saved: Language.");
  await expect(bar.getByRole("alert")).toContainText("Preferences fixture failure");
  await bar.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(bar).toHaveCount(0);
  expect(calls(state, "PATCH", "/preferences")).toHaveLength(1);
});

test("rows, browser back and closing the page ask while the tab has changes", async ({
  page,
}) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings?tab=operations");
  await page.getByRole("tab", { name: "Allgemein" }).click();
  await page
    .getByRole("switch", { name: "Unterbrochene Sessions automatisch fortsetzen" })
    .click();
  const unload = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await unload()).toBe(true);
  const sheet = page.getByRole("dialog", { name: "Änderungen speichern?" });
  await settingsRow(page, "MCP & Zugriffe (AgentPier für CLIs)").click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings$/);
  await page.evaluate(() => history.back());
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?tab=operations$/);
  expect(await unload()).toBe(false);
});

test("hints open as disclosures with their text verbatim", async ({ page }) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings");
  const info = page
    .locator(".toggle-row")
    .filter({ hasText: "Unterbrochene Sessions automatisch fortsetzen" })
    .getByRole("button", { name: "Hinweis anzeigen" });
  await expect(info).toHaveAttribute("aria-expanded", "false");
  await info.click();
  await expect(info).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(`#${await info.getAttribute("aria-controls")}`);
  await expect(panel).toHaveText(
    "Nach einem Neustart oder dem Verlust des Terminal-Servers setzt AgentPier jede unterbrochene Session nacheinander mit ihrer eigenen Unterhaltung fort. Von dir beendete Sessions bleiben beendet.",
  );
  await info.click();
  await expect(panel).toBeHidden();
});

test("saving the language before the workspace loaded sends no preferences", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.hold = "/state";
  await page.goto(baseURL + "/settings");
  await expect(
    page.getByText("Einstellungen werden geladen …", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Sprache", { exact: true }).selectOption("en");
  await settingsBar(page)
    .getByRole("button", { name: "Einstellungen speichern", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  state.hold = "";
  state.release?.();
  await expect(page.getByLabel("Default working directory", { exact: true })).toHaveValue(
    "/fixture",
  );
  await expect(settingsBar(page)).toHaveCount(0);
  expect(calls(state, "PATCH", "/preferences")).toEqual([]);
});

test.describe("settings workspace field checks", () => {
  test.use({ locale: "en-GB" });

  test("an empty directory saves nothing, not even the language", async ({ page }) => {
    const state = await operationsFixture(page);
    await page.goto(baseURL + "/settings");
    const directory = page.getByLabel("Default working directory", { exact: true });
    await expect(directory).toHaveValue("/fixture");
    await directory.fill("");
    // The field error below the card; the bar keeps the last save's message.
    const required = page.locator("div.error", {
      hasText: "Enter a default working directory.",
    });
    await expect(required).toBeVisible();
    await page.getByLabel("Language", { exact: true }).selectOption("de");
    await settingsBar(page)
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(settingsBar(page).getByRole("alert")).toHaveText(
      "Enter a default working directory.",
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(calls(state, "PATCH", "/preferences")).toEqual([]);
    await directory.fill("/fixture/next");
    await expect(required).toHaveCount(0);
  });

  test("signing out with unsaved changes asks like a navigation", async ({ page }) => {
    await operationsFixture(page);
    // A mocked sign-out keeps the shared browser login for the other specs.
    let logouts = 0;
    await page.route("**/auth/logout", (route) => {
      logouts++;
      return route.fulfill({ status: 204, body: "" });
    });
    await page.goto(baseURL + "/settings");
    const resume = page.getByRole("switch", {
      name: "Resume interrupted sessions automatically",
    });
    await expect(resume).toBeEnabled();
    const before = await resume.isChecked();
    await resume.click();
    const signOut = async () => {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page
        .locator("#sidebar-menu")
        .getByRole("button", { name: "Sign out" })
        .click();
    };
    const sheet = page.getByRole("dialog", { name: "Save changes?" });
    await signOut();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
    expect(logouts).toBe(0);
    await expect(page.locator(".login-page")).toHaveCount(0);
    await expect(resume).toBeChecked({ checked: !before });
    await signOut();
    await sheet.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".login-page")).toBeVisible();
    expect(logouts).toBe(1);
  });

  test("closing the unsaved sheet returns focus to what opened it", async ({ page }) => {
    await operationsFixture(page);
    await page.goto(baseURL + "/settings");
    await page
      .getByRole("switch", { name: "Resume interrupted sessions automatically" })
      .click();
    const sheet = page.getByRole("dialog", { name: "Save changes?" });
    const row = settingsRow(page, "MCP & access (AgentPier for CLIs)");
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(row).toBeFocused();
    // An arrow key switch the sheet refused leaves focus on the tab still selected.
    // ArrowLeft wraps to Operations, the last tab.
    const workspace = page.getByRole("tab", { name: "General" });
    const operations = page.getByRole("tab", { name: "Operations" });
    await workspace.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(workspace).toHaveAttribute("aria-selected", "true");
    await expect(workspace).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await sheet.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(operations).toHaveAttribute("aria-selected", "true");
    await expect(operations).toBeFocused();
  });

  test("an agent switch the server did not apply stays unsaved", async ({ page }) => {
    await operationsFixture(page);
    const feature = await featureRoute(page);
    feature.answer = { enabled: false, error: "ASSISTANT_STORAGE_UNSAFE" };
    // The switch lives on Agenten › Laufzeit; Settings › General links there.
    await page.goto(baseURL + "/settings");
    await page.getByRole("link", { name: /^Agents.*Off$/ }).click();
    await expect(page).toHaveURL(/\/agents\?tab=runtime$/);
    const agents = page.getByRole("switch", { name: "Enable agents" });
    await agents.click();
    await settingsBar(page)
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(settingsBar(page).getByRole("alert")).toHaveText(
      "Agents were not switched. See the agent diagnostic.",
    );
    await expect(page.getByText(/^Agent diagnostic: /)).toBeVisible();
    await expect(agents).toBeChecked();
    await expect(page.getByText("Settings saved.", { exact: true })).toHaveCount(0);
    expect(feature.puts).toEqual([{ enabled: true }]);
  });
});
