import { test, expect } from "@playwright/test";

import { fixture, openRepositories, stamp } from "../helpers/repository-browser.js";
test("profile discovery filters organizations and repositories and fills the clone form", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  const requests = [];
  await page.route("**/api/repositories/discover?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(Object.fromEntries(params));
    const all = [
      {
        id: "1",
        name: "project",
        fullName: "Acme/project",
        owner: "Acme",
        url: "https://github.com/Acme/project.git",
        private: true,
      },
      {
        id: "2",
        name: "other",
        fullName: "Other/other",
        owner: "Other",
        url: "https://github.com/Other/other.git",
        private: false,
      },
    ];
    const found = all.filter(
      (repo) =>
        (!params.get("organization") || repo.owner === params.get("organization")) &&
        repo.fullName.includes(params.get("q") || ""),
    );
    await route.fulfill({
      json: {
        organizations: [{ login: "Acme" }, { login: "Other" }],
        repositories: found,
        total: found.length,
        page: 1,
        hasMore: false,
        truncated: false,
      },
    });
  });
  await openRepositories(page);
  await page.getByLabel("Token-Profil").selectOption("personal");
  await page.getByRole("button", { name: "Organisation", exact: true }).click();
  await page.getByRole("option", { name: "Acme", exact: true }).click();
  await page
    .getByRole("button", { name: "Verfügbare Repositories", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Repository suchen" }).fill("project");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: "Acme/project · Privat", exact: true }).click();
  await expect(page.getByLabel("Repository-URL oder owner/repo")).toHaveValue(
    "https://github.com/Acme/project.git",
  );
  await expect(page.getByLabel("Neuer Ordnername")).toHaveValue("project");
  await page.getByRole("button", { name: "Repository klonen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "project", exact: true })).toBeVisible();
  expect(writes.find((write) => write.path.endsWith("/clone")).body.credentialId).toBe(
    "personal",
  );
  expect(
    requests.some(
      (request) =>
        request.credentialId === "personal" &&
        request.q === "project" &&
        request.organization === "Acme",
    ),
  ).toBeTruthy();
});

test("discovery errors leave manual clone available and switching to public clears discovery", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/repositories/discover?*", (route) =>
    route.fulfill({ status: 403, json: { error: "Token-Berechtigungen prüfen" } }),
  );
  await openRepositories(page);
  await page.getByLabel("Token-Profil").selectOption("personal");
  await expect(page.getByRole("alert")).toContainText("Token-Berechtigungen prüfen");
  await page.getByLabel("Repository-URL oder owner/repo").fill("acme/manual");
  await page.getByLabel("Neuer Ordnername").fill("manual");
  await expect(
    page.getByRole("button", { name: "Repository klonen", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Token-Profil").selectOption("");
  await expect(page.getByLabel("Verfügbare Repositories")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("changing discovery profiles ignores an older response and fits mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { repositories } = await fixture(page);
  repositories.credentials.push({
    id: "enterprise",
    name: "Enterprise",
    host: "https://git.example.org",
    hasSecret: true,
    createdAt: stamp,
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let oldStarted = false;
  await page.route("**/api/repositories/discover?*", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("credentialId");
    if (id === "personal") {
      oldStarted = true;
      await held;
    }
    const owner = id === "personal" ? "Old" : "Enterprise";
    await route
      .fulfill({
        json: {
          organizations: [{ login: owner }],
          repositories: [
            {
              id: owner,
              name: "project",
              fullName: `${owner}/project`,
              url: `https://git.example.org/${owner}/project.git`,
              private: true,
              owner,
            },
          ],
          total: 1,
          page: 1,
          hasMore: false,
          truncated: false,
        },
      })
      .catch(() => {});
  });
  await openRepositories(page);
  await page.getByLabel("Token-Profil").selectOption("personal");
  await expect.poll(() => oldStarted).toBeTruthy();
  await page.getByLabel("Token-Profil").selectOption("enterprise");
  await page
    .getByRole("button", { name: "Verfügbare Repositories", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "Enterprise/project · Privat" }),
  ).toHaveCount(1);
  release();
  await page.getByRole("option", { name: "Enterprise/project · Privat" }).click();
  await expect(page.getByLabel("Repository-URL oder owner/repo")).toHaveValue(
    "https://git.example.org/Enterprise/project.git",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await expect(page.getByRole("option", { name: "Old/project · Privat" })).toHaveCount(0);
});

test("Enter in repository search does not submit a filled clone form", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await openRepositories(page);
  await page.getByLabel("Token-Profil").selectOption("personal");
  await page.getByLabel("Repository-URL oder owner/repo").fill("acme/project");
  await page.getByLabel("Neuer Ordnername").fill("project");
  await page
    .getByRole("button", { name: "Verfügbare Repositories", exact: true })
    .click();
  await page.getByLabel("Repository suchen").fill("project");
  await page.getByLabel("Repository suchen").press("Enter");
  await expect(page.getByLabel("Repository suchen")).toHaveValue("project");
  await expect(page.getByRole("heading", { name: "project", exact: true })).toHaveCount(
    0,
  );
  expect(writes.filter((write) => write.path.endsWith("/clone"))).toHaveLength(0);
});
