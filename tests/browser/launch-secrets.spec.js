import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { addGrant, grantOption } from "../helpers/grant-picker.js";
import { openNewSession } from "../helpers/navigation.js";
import { secretsFixture } from "./secrets-fixture.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
});

async function launchFixture(page) {
  const state = await secretsFixture(page);
  state.launches = [];
  await page.route("**/api/ssh-accesses", (route) =>
    route.fulfill({ json: { accesses: [] } }),
  );
  await page.route("**/api/sessions", (route) => {
    state.launches.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Launch rejected" } });
  });
  return state;
}
const dialog = (page) => page.getByRole("dialog");
async function openExtensions(page, cwd) {
  await page.goto(baseURL);
  await openNewSession(page);
  if (cwd) await dialog(page).getByLabel("Working directory", { exact: true }).fill(cwd);
  await dialog(page).locator(".launch-extensions > summary").click();
}
const start = (page) =>
  dialog(page).getByRole("button", { name: "Start session", exact: true }).click();

test("every secret is an optional choice with its owner, sent as secretIds", async ({
  page,
}) => {
  const state = await launchFixture(page);
  await openExtensions(page, "/work/app/server");
  const secrets = dialog(page).getByRole("group", { name: "Secrets" });
  await expect(dialog(page).getByText(/own project are always included/)).toBeVisible();
  // No project guess: a project's secret is offered like any other, with its owner.
  const project = await grantOption(secrets, "Add secret", "DATABASE_URL");
  await expect(project).toBeVisible();
  await expect(project).not.toHaveAttribute("aria-disabled", "true");
  await expect(project).toHaveAttribute("aria-selected", "false");
  await expect(project).toContainText("Agent app");
  const global = await grantOption(secrets, "Add secret", "GITHUB_TOKEN");
  await expect(global).toContainText("Global");
  await addGrant(secrets, "Add secret", "GITHUB_TOKEN");
  await addGrant(secrets, "Add secret", "DATABASE_URL");
  await start(page);
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect(state.launches[0].secretIds).toEqual(["secret-github", "secret-db"]);
  await expect(secrets.getByText("GITHUB_TOKEN", { exact: true })).toBeVisible();
});

test("unchosen secrets send nothing, and an unreadable project list shows ids", async ({
  page,
}) => {
  const state = await launchFixture(page);
  await page.route("**/api/ssh-projects", (route) =>
    route.fulfill({ status: 500, json: { error: "Projects failed" } }),
  );
  await openExtensions(page, "/work/docs");
  const secrets = dialog(page).getByRole("group", { name: "Secrets" });
  const option = await grantOption(secrets, "Add secret", "DATABASE_URL");
  await expect(option).not.toHaveAttribute("aria-disabled", "true");
  await expect(option).toContainText("project-app");
  await start(page);
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect("secretIds" in state.launches[0]).toBe(false);
});

test("the secrets choice is hidden when no secrets exist", async ({ page }) => {
  const state = await launchFixture(page);
  state.secrets = [];
  await openExtensions(page);
  await expect(dialog(page).getByText("SSH accesses").first()).toBeVisible();
  await expect(dialog(page).getByRole("group", { name: "Secrets" })).toHaveCount(0);
});
