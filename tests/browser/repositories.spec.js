import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";

import { fixture, openRepositories, stamp } from "../helpers/repository-browser.js";
test("repository tokens support multiple profiles, private blank-preserving edits and deletion", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await openRepositories(page);
  await page.getByRole("button", { name: "Token hinzufügen" }).click();
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

test("agent defaults are selected per host, refresh all badges and retain clone drafts", async ({
  page,
}) => {
  const { repositories, writes } = await fixture(page);
  repositories.credentials.push({
    id: "enterprise",
    name: "Enterprise",
    host: "https://git.example.org",
    hasSecret: true,
    agentDefault: true,
    createdAt: stamp,
  });
  await openRepositories(page);
  const profile = (name) =>
    page
      .locator(".repository-credential")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(profile("Persönlich")).toContainText("Standard für Agenten");
  await expect(profile("Enterprise")).toContainText("Standard für Agenten");
  await expect(
    page.getByText(
      "Neue Agent-Sitzungen erhalten je Host den Standardzugang. Geklonte Projekte verwenden ihren gewählten Zugang.",
    ),
  ).toBeVisible();
  await page.getByLabel("Repository-URL oder owner/repo").fill("acme/draft");
  await page.getByRole("button", { name: "Token hinzufügen", exact: true }).click();
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
  await expect(page.getByLabel("Repository-URL oder owner/repo")).toHaveValue(
    "acme/draft",
  );
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

test("clone failures keep fields, pending requests cannot duplicate, and projects launch with their path", async ({
  page,
}) => {
  const { writes, state } = await fixture(page);
  await openRepositories(page);
  await page.getByLabel("Repository-URL oder owner/repo").fill("acme/project");
  await page.getByLabel("Neuer Ordnername").fill("project");
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/repositories/clone",
    async (route) => {
      await pending;
      await route.fulfill({
        status: 409,
        json: { error: "Zielordner existiert bereits" },
      });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Repository klonen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Wird geklont …" })).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText("Zielordner existiert bereits");
  await expect(page.getByLabel("Repository-URL oder owner/repo")).toHaveValue(
    "acme/project",
  );
  await expect(page.getByLabel("Übergeordneter Ordner")).toHaveValue("/home/test");
  await page.getByLabel("Neuer Ordnername").fill("project-new");
  await page.getByRole("button", { name: "Repository klonen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "project-new", exact: true }),
  ).toBeVisible();
  expect(writes.find((write) => write.path.endsWith("/clone")).body).toEqual({
    credentialId: null,
    url: "acme/project",
    parentDirectory: "/home/test",
    folderName: "project-new",
  });
  await page.getByRole("button", { name: "Sitzung in project-new starten" }).click();
  await expect(page.getByLabel("Arbeitsverzeichnis", { exact: true })).toHaveValue(
    "/home/test/project-new",
  );
  await page.getByRole("button", { name: "Sitzung starten", exact: true }).click();
  expect(state.sessions[0].cwd).toBe("/home/test/project-new");
});

test("mobile repositories and Enterprise profile errors preserve input without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { repositories } = await fixture(page);
  repositories.projects.push({
    id: "existing",
    name: "a-long-enterprise-project-name",
    path: "/home/test/a-long-enterprise-project-name",
    url: "https://github.enterprise.example:8443/team/a-long-enterprise-project-name.git",
    credentialId: "personal",
    createdAt: stamp,
  });
  await openRepositories(page);
  await expect(
    page.getByRole("heading", { name: "a-long-enterprise-project-name" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Token hinzufügen" }).click();
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
    .getByRole("dialog", { name: "Token hinzufügen", exact: true })
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

test("public GitHub clone works without any token profile", async ({ page }) => {
  const { repositories, writes } = await fixture(page);
  repositories.credentials = [];
  await openRepositories(page);
  await expect(page.getByLabel("Token-Profil")).toHaveValue("");
  await page
    .getByLabel("Repository-URL oder owner/repo")
    .fill("https://github.com/octocat/Hello-World.git");
  await page.getByLabel("Neuer Ordnername").fill("public-project");
  await page.getByRole("button", { name: "Repository klonen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "public-project", exact: true }),
  ).toBeVisible();
  expect(
    writes.find((write) => write.path.endsWith("/clone")).body.credentialId,
  ).toBeNull();
});

for (const outcome of ["success", "failure"]) {
  test(`clone ${outcome} survives leaving and returning to repositories while pending`, async ({
    page,
  }) => {
    await fixture(page);
    await openRepositories(page);
    let release;
    let requests = 0;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/repositories/clone", async (route) => {
      requests++;
      await pending;
      await route.fulfill(
        outcome === "success"
          ? {
              json: {
                id: "pending-project",
                name: "pending-project",
                path: "/home/test/pending-project",
                url: "https://github.com/acme/project.git",
                credentialId: "personal",
                createdAt: stamp,
              },
            }
          : {
              status: 409,
              json: { error: "Klonen nach Ansichtswechsel fehlgeschlagen" },
            },
      );
    });
    await page.getByLabel("Repository-URL oder owner/repo").fill("acme/project");
    await page.getByLabel("Neuer Ordnername").fill("pending-project");
    await page.getByRole("button", { name: "Repository klonen", exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await navigateTo(page, "Konten");
    await navigateTo(page, "Repositories");
    try {
      await expect(page.getByRole("button", { name: "Wird geklont …" })).toBeDisabled();
    } finally {
      release();
    }
    if (outcome === "success") {
      await expect(
        page.getByRole("heading", { name: "pending-project", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Sitzung in pending-project starten" })
        .click();
      await expect(page.getByLabel("Arbeitsverzeichnis", { exact: true })).toHaveValue(
        "/home/test/pending-project",
      );
    } else {
      await expect(page.getByRole("alert")).toContainText(
        "Klonen nach Ansichtswechsel fehlgeschlagen",
      );
      await expect(page.getByLabel("Repository-URL oder owner/repo")).toHaveValue(
        "acme/project",
      );
      await expect(page.getByLabel("Neuer Ordnername")).toHaveValue("pending-project");
      await expect(
        page.getByRole("button", { name: "Repository klonen", exact: true }),
      ).toBeEnabled();
    }
    expect(requests).toBe(1);
  });
}

for (const customDirectory of [null, "/custom/projects"])
  test(`clone uses ${customDirectory ? "an explicit folder over" : "the saved"} default directory`, async ({
    page,
  }) => {
    const { state, writes } = await fixture(page);
    state.defaultCwd = "/work";
    await openRepositories(page);
    await expect(page.getByLabel("Übergeordneter Ordner", { exact: true })).toHaveValue(
      "/work",
    );
    if (customDirectory)
      await page
        .getByLabel("Übergeordneter Ordner", { exact: true })
        .fill(customDirectory);
    await page.getByLabel("Repository-URL oder owner/repo").fill("acme/project");
    await page.getByLabel("Neuer Ordnername").fill("project");
    await page.getByRole("button", { name: "Repository klonen", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "project", exact: true }),
    ).toBeVisible();
    expect(
      writes.find((write) => write.path.endsWith("/clone")).body.parentDirectory,
    ).toBe(customDirectory || "/work");
  });
