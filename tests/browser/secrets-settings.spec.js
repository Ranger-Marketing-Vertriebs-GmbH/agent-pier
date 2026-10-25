import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsRow } from "../helpers/settings.js";
import { secretsFixture } from "./secrets-fixture.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
});

const list = (page) => page.getByRole("navigation", { name: "Secrets" });
const item = (page, name) =>
  list(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });
const writes = (state) => state.calls.filter((call) => call.method !== "GET");

test("the access tab lists secrets with their count", async ({ page }) => {
  const state = await secretsFixture(page);
  state.base.summary.access.secrets = { count: 2 };
  await page.goto(baseURL + "/settings?tab=access");
  const row = settingsRow(page, "Secrets");
  await expect(row).toContainText("Tokens and URLs for agents and coding CLIs");
  await expect(row).toContainText("2");
  await row.click();
  await expect(page).toHaveURL(/\/settings\/secrets$/);
  await expect(page.getByRole("heading", { name: "Secrets", exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Agents and sessions that receive a secret can read its value. Use tokens with the fewest rights the task needs.",
    ),
  ).toBeVisible();
  await expect(item(page, "GITHUB_TOKEN")).toContainText("Read-only token");
  await expect(item(page, "GITHUB_TOKEN")).toContainText("Global");
  await expect(item(page, "DATABASE_URL")).toContainText("Agent app");
});

test("a new secret is created, listed and shows its value only as saved", async ({
  page,
}) => {
  const state = await secretsFixture(page);
  await page.goto(baseURL + "/settings/secrets");
  await page.getByRole("button", { name: "New secret", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("ZABBIX_TOKEN");
  await page.getByLabel("Description", { exact: true }).fill("Zabbix API");
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("");
  await expect(
    page.getByLabel("Project", { exact: true }).getByRole("option"),
  ).toHaveText(["Global", "Agent app", "Docs"]);
  await page.getByLabel("Value", { exact: true }).fill("zbx-s3cr3t");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(item(page, "ZABBIX_TOKEN")).toContainText("Zabbix API");
  expect(writes(state)).toEqual([
    {
      path: "/api/secrets",
      method: "POST",
      body: {
        name: "ZABBIX_TOKEN",
        description: "Zabbix API",
        projectId: null,
        value: "zbx-s3cr3t",
      },
    },
  ]);
  await expect(page.getByText("Value saved", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Value", { exact: true })).toHaveCount(0);
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  await expect(page.getByText("zbx-s3cr3t")).toHaveCount(0);
});

test("saving keeps the value unless it is replaced", async ({ page }) => {
  const state = await secretsFixture(page);
  await page.goto(baseURL + "/settings/secrets");
  await item(page, "DATABASE_URL").click();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("project-app");
  await page.getByLabel("Description", { exact: true }).fill("Staging database");
  await page.getByLabel("Project", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(item(page, "DATABASE_URL")).toContainText("Global");
  expect(writes(state)).toEqual([
    {
      path: "/api/secrets/secret-db",
      method: "PATCH",
      body: { name: "DATABASE_URL", description: "Staging database", projectId: null },
    },
  ]);
  await page.getByRole("button", { name: "Replace value", exact: true }).click();
  const value = page.getByLabel("Value", { exact: true });
  await expect(value).toHaveValue("");
  await expect(value).toHaveAttribute("type", "password");
  await value.fill("postgres://new");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Value saved", { exact: true })).toBeVisible();
  expect(writes(state).at(-1)).toEqual({
    path: "/api/secrets/secret-db",
    method: "PATCH",
    body: {
      name: "DATABASE_URL",
      description: "Staging database",
      projectId: null,
      value: "postgres://new",
    },
  });
});

test("an invalid or taken name shows the translated error", async ({ page }) => {
  await secretsFixture(page);
  await page.goto(baseURL + "/settings/secrets");
  await page.getByRole("button", { name: "New secret", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("zabbix-token");
  await page.getByLabel("Value", { exact: true }).fill("zbx");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Invalid secret name. Use capital letters, digits and underscores, starting with a letter or underscore, at most 64 characters.",
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("zabbix-token");
  await page.getByLabel("Name", { exact: true }).fill("GITHUB_TOKEN");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "A secret with this name already exists.",
  );
});

test("delete asks for confirmation and sends DELETE", async ({ page }) => {
  const state = await secretsFixture(page);
  await page.goto(baseURL + "/settings/secrets");
  await item(page, "GITHUB_TOKEN").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete secret 'GITHUB_TOKEN'?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes(state)).toEqual([]);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(item(page, "GITHUB_TOKEN")).toHaveCount(0);
  expect(writes(state)).toEqual([
    { path: "/api/secrets/secret-github", method: "DELETE", body: null },
  ]);
});

test("a narrow viewport opens a secret as its own view and closes it", async ({
  page,
}) => {
  await secretsFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/settings/secrets");
  await item(page, "GITHUB_TOKEN").click();
  await expect(list(page)).toBeHidden();
  await expect(page.getByText("Value saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All secrets", exact: true }).click();
  await expect(item(page, "GITHUB_TOKEN")).toBeVisible();
  await expect(page.getByText("Value saved", { exact: true })).toBeHidden();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
