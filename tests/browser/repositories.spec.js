import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";

import { fixture, openRepositories, stamp } from "../helpers/repository-browser.js";
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

test("mobile repositories with long enterprise project names avoid horizontal overflow", async ({
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
    await navigateTo(page, "Accounts");
    await navigateTo(page, "Projekte");
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
