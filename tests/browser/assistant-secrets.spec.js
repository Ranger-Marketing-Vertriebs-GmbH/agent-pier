import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

const github = {
  id: "secret-github",
  name: "GITHUB_TOKEN",
  description: "Read-only token",
  projectId: null,
  projectName: null,
};
const database = {
  id: "secret-db",
  name: "DATABASE_URL",
  description: "",
  projectId: "project-app",
  projectName: "Agent app",
};
const catalog = (secrets = [database, github]) => ({
  projects: [],
  pipelines: [],
  sshHosts: [],
  secrets,
});
const row = (page) => page.getByRole("link", { name: /^Secrets/ });
const save = (page) => saveBar(page).getByRole("button", { name: "Save", exact: true });

test("secrets are picked and saved with the Work tab", async ({ page }) => {
  const state = await setup(page, { catalog: catalog() });
  await page.goto(baseURL + settingsPath("work"));
  await expect(row(page)).toContainText("None");
  await row(page).click();
  await expect(page.getByText(/\.agentpier\/secrets\.env/)).toBeVisible();
  await expect(page.getByText(/can read their values/)).toBeVisible();
  await expect(page.getByText("Read-only token · Global")).toBeVisible();
  await expect(page.getByText("Project: Agent app")).toBeVisible();
  await page.getByLabel("GITHUB_TOKEN", { exact: true }).check();
  await page.getByRole("button", { name: "Back to Work" }).click();
  await expect(row(page)).toContainText("1 secret");
  await save(page).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0].access.secretIds).toEqual(["secret-github"]);
});

test("a saved grant is shown and an unchanged list is not sent", async ({ page }) => {
  const state = await setup(page, {
    catalog: catalog(),
    access: { revision: 0, secretIds: ["secret-db"] },
  });
  await page.goto(baseURL + settingsPath("work", "secrets"));
  await expect(page.getByLabel("DATABASE_URL", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Back to Work" }).click();
  await expect(row(page)).toContainText("1 secret");
  await page
    .getByRole("switch", { name: /Allow proposals to update project memory/ })
    .check();
  await save(page).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect("secretIds" in state.work[0].access).toBe(false);
});

test("without secrets the page links to the secrets settings", async ({ page }) => {
  await setup(page, { catalog: catalog([]) });
  await page.goto(baseURL + settingsPath("work", "secrets"));
  await expect(page.getByText("There are no secrets yet.")).toBeVisible();
  await page.getByRole("button", { name: "Set up secrets" }).click();
  await expect(page).toHaveURL(/\/settings\/secrets\?/);
});

test("an unreadable secrets catalog shows an error with retry", async ({ page }) => {
  const state = await setup(page, { catalog: catalog(null) });
  await page.goto(baseURL + settingsPath("work", "secrets"));
  await expect(page.getByText("Secrets could not be loaded.")).toBeVisible();
  state.catalog = catalog();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("GITHUB_TOKEN", { exact: true })).toBeVisible();
});

test("an agent of users has no secrets and names the lock", async ({ page }) => {
  await setup(page, {
    catalog: catalog(),
    assistant: {
      userAccess: {
        mode: "own",
        members: [{ userId: "u-1", level: "chat" }],
        released: [],
      },
    },
  });
  await page.goto(baseURL + settingsPath("work", "secrets"));
  await expect(page.getByRole("note")).toContainText(/Locked: .*Secrets/);
  await expect(row(page)).toHaveCount(0);
  await expect(page.getByLabel("GITHUB_TOKEN", { exact: true })).toHaveCount(0);
});
