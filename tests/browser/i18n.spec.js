import { test, expect } from "@playwright/test";
import { openMenu } from "../helpers/navigation.js";
import { chooseLanguage, settingsBar } from "../helpers/settings.js";

test("login detects browser language and preserves typed values when switching", async ({
  page,
}) => {
  await page.route("**/auth/status", (route) =>
    route.fulfill({
      json: { configured: true, authenticated: false },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Anmelden", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Benutzername", { exact: true }).fill("my unchanged username");
  await page.getByLabel("Sprache", { exact: true }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(
    "my unchanged username",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.reload();
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("settings switches the workspace language on save and keeps unsaved form values", async ({
  page,
  context,
  browserName,
}) => {
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  // The directory stays an unsaved draft: its save fails on purpose, so the language
  // is saved alone and the bar reports a partial save in the new language.
  await page.route("**/api/preferences", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 400, json: { error: "Directory fixture refusal" } })
      : route.fallback(),
  );
  const directory = page.locator(".directory-row input");
  await directory.fill("/tmp/unchanged-language-draft");
  await chooseLanguage(page, "en");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(settingsBar(page).getByRole("alert")).toContainText(
    "Partially saved: Language.",
  );
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(directory).toHaveValue("/tmp/unchanged-language-draft");
  const other = await context.newPage();
  await other.goto("/settings");
  await expect(other.getByLabel("Language", { exact: true })).toHaveValue("en");
  await chooseLanguage(other, "de");
  await expect(
    page.getByRole("heading", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  await expect(directory).toHaveValue("/tmp/unchanged-language-draft");
  await other.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  await page.screenshot({
    path: `/tmp/agentpier-language-de-${browserName}.png`,
    fullPage: true,
  });
  await chooseLanguage(page, "en");
  await expect(page).toHaveTitle("AgentPier — Your terminal. Anywhere.");
  await page.screenshot({
    path: `/tmp/agentpier-language-en-${browserName}.png`,
    fullPage: true,
  });
});

test.describe("English browser", () => {
  test.use({ locale: "en-GB" });
  test("starts in English without a saved choice", async ({ page }) => {
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});

test("directory editing waits for initial settings and later refresh preserves drafts", async ({
  page,
}) => {
  let releaseInitial;
  const initial = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  const state = {
    tools: [],
    accounts: [{ id: "fixture-account", tool: "codex" }],
    sessions: [],
    home: "/fixture/initial-home",
  };
  await page.route("**/api/state", async (route) => {
    await initial;
    await route.fulfill({ json: state });
  });
  await page.goto("/settings");
  const directory = page.locator(".directory-row input");
  await expect(directory).toHaveValue("");
  await expect(directory).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Standardordner auswählen", exact: true }),
  ).toBeDisabled();
  await expect(settingsBar(page)).toHaveCount(0);
  await chooseLanguage(page, "en");
  await expect(page.getByText("Loading settings…", { exact: true })).toBeVisible();
  await chooseLanguage(page, "de");
  const loaded = page.waitForResponse("**/api/state");
  releaseInitial();
  await loaded;
  await openMenu(page);
  await expect(
    page
      .locator("#sidebar-menu")
      .getByRole("button", { name: "Accounts", exact: true })
      .locator(".count"),
  ).toHaveText("1");
  await expect(directory).toBeEnabled();
  await expect(directory).toHaveValue("/fixture/initial-home");
  await directory.fill("/fixture/my-unsaved-directory");
  await chooseLanguage(page, "en");
  await expect(directory).toHaveValue("/fixture/my-unsaved-directory");
  state.home = "/fixture/refreshed-home";
  const refreshed = page.waitForResponse("**/api/state");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await refreshed;
  // The refreshed home conflicts with the unsaved directory: the draft stays and the
  // bar asks for a decision instead of saving over it.
  await expect(directory).toHaveValue("/fixture/my-unsaved-directory");
  await expect(settingsBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  await expect(
    settingsBar(page).getByRole("button", { name: "Overwrite anyway", exact: true }),
  ).toBeVisible();
});

test("focusing a loaded settings field cannot erase native input before its input event", async ({
  page,
}) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/state", async (route) => {
    await pending;
    await route.fulfill({
      json: { tools: [], accounts: [], sessions: [], home: "/fixture/home" },
    });
  });
  await page.goto("/settings");
  const directory = page.locator(".directory-row input");
  await expect(directory).toBeDisabled();
  const loaded = page.waitForResponse("**/api/state");
  release();
  await loaded;
  await expect(directory).toBeEnabled();
  await expect(directory).toHaveValue("/fixture/home");
  // Native editing and input delivery can straddle a React focus update in WebKit.
  // setRangeText edits the native value without invoking React's value setter.
  await directory.evaluate(async (input) => {
    input.focus();
    input.setRangeText("/fixture/native-draft", 0, input.value.length, "end");
    await new Promise((resolve) => setTimeout(resolve, 0));
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "/fixture/native-draft",
      }),
    );
  });
  await expect(directory).toHaveValue("/fixture/native-draft");
  await chooseLanguage(page, "en");
  await expect(directory).toHaveValue("/fixture/native-draft");
});
