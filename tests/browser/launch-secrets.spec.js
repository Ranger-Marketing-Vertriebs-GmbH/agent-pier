import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
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

test("a global secret is chosen for the session and sent as secretIds", async ({
  page,
}) => {
  const state = await launchFixture(page);
  await openExtensions(page, "/work/app/server");
  const secrets = dialog(page).getByRole("group", { name: "Secrets" });
  // The project's own secret comes with the session and cannot be unticked.
  const own = secrets.getByRole("checkbox", { name: "DATABASE_URL" });
  await expect(own).toBeChecked();
  await expect(own).toBeDisabled();
  await expect(secrets).toContainText("Project");
  const global = secrets.getByRole("checkbox", { name: "GITHUB_TOKEN" });
  await expect(global).not.toBeChecked();
  await global.check();
  await start(page);
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect(state.launches[0].secretIds).toEqual(["secret-github"]);
  await expect(global).toBeChecked();
});

test("another project's secret can be chosen, and none is sent unchosen", async ({
  page,
}) => {
  const state = await launchFixture(page);
  await openExtensions(page, "/work/docs");
  const secrets = dialog(page).getByRole("group", { name: "Secrets" });
  const other = secrets.getByRole("checkbox", { name: "DATABASE_URL" });
  await expect(other).toBeEnabled();
  await expect(other).not.toBeChecked();
  await expect(secrets).toContainText("Agent app");
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
