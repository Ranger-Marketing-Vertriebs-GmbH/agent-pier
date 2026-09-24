import { test, expect } from "@playwright/test";

import { baseURL as base } from "../helpers/browser.js";
import { navigateTo } from "../helpers/navigation.js";
import {
  fixture,
  openCloneDialog,
  openRepositories,
  stamp,
} from "../helpers/repository-browser.js";

test("GitHub access tokens support multiple profiles, private blank-preserving edits and deletion", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.goto(base + "/settings/github");
  await page.getByRole("button", { name: "Zugang hinzufügen" }).click();
  await page.getByLabel("Profilname").fill("Arbeit");
  await page.getByLabel("GitHub-Host").fill("https://github.com");
  await page.getByLabel("Access Token", { exact: true }).fill("private-token-value");
  await page.getByRole("button", { name: "Token speichern", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Arbeit", exact: true })).toBeVisible();
  await expect(page.getByText("private-token-value")).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Arbeit bearbeiten" }).click();
  await expect(page.getByLabel("Access Token", { exact: true })).toHaveValue("");
  await page.getByLabel("Profilname").fill("Arbeit privat");
  await page.getByRole("button", { name: "Token speichern", exact: true }).click();
  expect(writes.find((write) => write.method === "PATCH").body).toEqual({
    name: "Arbeit privat",
    host: "https://github.com",
    agentDefault: false,
  });
  await page.getByRole("button", { name: "Arbeit privat löschen" }).click();
  await page.getByRole("button", { name: "Token löschen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Arbeit privat", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Persönlich", exact: true }),
  ).toBeVisible();
});

test("agent defaults are selected per host and refresh all badges", async ({ page }) => {
  const { repositories, writes } = await fixture(page);
  repositories.credentials.push({
    id: "enterprise",
    name: "Enterprise",
    host: "https://git.example.org",
    hasSecret: true,
    agentDefault: true,
    createdAt: stamp,
  });
  await page.goto(base + "/settings/github");
  const profile = (name) =>
    page
      .locator('[role="row"]')
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(profile("Persönlich")).toContainText("Standard für Agenten");
  await expect(profile("Enterprise")).toContainText("Standard für Agenten");
  await expect(
    page.getByText(
      "Neue Agent-Sitzungen erhalten je Host den Standardzugang. Geklonte Projekte verwenden ihren gewählten Zugang.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zugang hinzufügen", exact: true }).click();
  await page.getByLabel("Profilname").fill("Arbeit");
  await page.getByLabel("Access Token", { exact: true }).fill("never-render-this-token");
  const toggle = page.getByRole("checkbox", {
    name: "Standard für Agenten auf diesem Host",
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole("button", { name: "Token speichern", exact: true }).click();
  await expect(profile("Arbeit")).toContainText("Standard für Agenten");
  await expect(profile("Persönlich")).not.toContainText("Standard für Agenten");
  await expect(profile("Enterprise")).toContainText("Standard für Agenten");
  await expect(page.getByText("never-render-this-token")).toHaveCount(0);
  await page.getByRole("button", { name: "Arbeit bearbeiten" }).click();
  await expect(toggle).toBeChecked();
  await page.getByLabel("GitHub-Host").fill("https://git.other.example:8443");
  await expect(page.getByText("GitHub CLI unterstützt Hosts ohne Port.")).toBeVisible();
  await page.getByRole("button", { name: "Token speichern", exact: true }).click();
  await expect(profile("Persönlich")).toContainText("Standard für Agenten");
  expect(
    writes.find(
      (write) => write.method === "POST" && write.path === "/api/git-credentials",
    ).body.agentDefault,
  ).toBe(true);
  expect(writes.find((write) => write.method === "PATCH").body).toEqual({
    name: "Arbeit",
    host: "https://git.other.example:8443",
    agentDefault: true,
  });
});

test("mobile GitHub access and Enterprise profile errors preserve input without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto(base + "/settings/github");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Zugang hinzufügen" }).click();
  await page.getByLabel("Profilname").fill("Enterprise");
  await page.getByLabel("GitHub-Host").fill("https://github.enterprise.example:8443");
  await expect(
    page.getByRole("checkbox", {
      name: "Standard für Agenten auf diesem Host",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "Standard für Agenten auf diesem Host",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("dialog", { name: "Zugang hinzufügen", exact: true })
    .screenshot({ path: "/tmp/agentpier-gh-credentials-mobile.png" });
  await page.getByLabel("Access Token", { exact: true }).fill("enterprise-private-token");
  await page.route(
    "**/api/git-credentials",
    (route) =>
      route.fulfill({
        status: 500,
        json: { error: "Profil konnte nicht gespeichert werden" },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Token speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Profil konnte nicht gespeichert werden",
  );
  await expect(page.getByLabel("GitHub-Host")).toHaveValue(
    "https://github.enterprise.example:8443",
  );
  await expect(page.getByLabel("Access Token", { exact: true })).toHaveValue(
    "enterprise-private-token",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Token speichern", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Enterprise", exact: true }),
  ).toBeVisible();
});

test("token changes wait while a clone started elsewhere is running", async ({
  page,
}) => {
  await fixture(page);
  await openRepositories(page);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/repositories/clone", async (route) => {
    await pending;
    await route.fulfill({ status: 409, json: { error: "Klonen abgebrochen" } });
  });
  const dialog = await openCloneDialog(page);
  await dialog.getByLabel("Repository-URL oder owner/repo").fill("acme/project");
  await dialog.getByLabel("Neuer Ordnername").fill("pending-project");
  await dialog.getByRole("button", { name: "Repository klonen", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Wird geklont …" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await navigateTo(page, "Einstellungen");
  await page.getByRole("button", { name: "GitHub-Zugänge", exact: true }).click();
  const edit = page.getByRole("button", { name: "Persönlich bearbeiten" });
  const remove = page.getByRole("button", { name: "Persönlich löschen" });
  const add = page.getByRole("button", { name: "Zugang hinzufügen" });
  try {
    await expect(edit).toBeDisabled();
    await expect(remove).toBeDisabled();
    await expect(add).toBeDisabled();
  } finally {
    release();
  }
  await expect(edit).toBeEnabled();
  await expect(remove).toBeEnabled();
  await expect(add).toBeEnabled();
});
