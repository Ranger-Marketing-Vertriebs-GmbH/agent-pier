import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./ssh-fixture.js";

import {
  detail as card,
  openAccess,
  openKey,
  showAccesses,
  showKeys,
} from "./ssh-settings-helpers.js";

test("same-name projects expose their directories when choosing SSH ownership", async ({
  page,
}) => {
  const state = await fixture(page);
  state.projects = [
    { id: "project-app", name: "app", cwd: "/first/app", kind: "git" },
    { id: "project-docs", name: "app", cwd: "/second/app", kind: "git" },
  ];
  state.keys[0].projectId = "project-app";
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  const labels = ["app · /first/app", "app · /second/app"];
  await expect(
    page.getByRole("combobox", { name: "Project filter" }).locator("option"),
  ).toHaveText(["All owners", "Global", ...labels]);
  await openKey(page, "Deployment key");
  await expect(card(page, "Deployment key")).toContainText(labels[0]);
  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  await page.getByRole("combobox", { name: "Owner" }).selectOption({ label: labels[1] });
  await page.getByLabel("Name", { exact: true }).fill("Second clone key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(state.keys.find((key) => key.name === "Second clone key").projectId).toBe(
    "project-docs",
  );
  await showAccesses(page);
  await page.getByRole("button", { name: "Add access", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Owner" }).locator("option"),
  ).toHaveText(["Global", ...labels]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Reassign project resources" }).click();
  await expect(
    page.getByRole("combobox", { name: "From project" }).locator("option"),
  ).toHaveText(labels);
  await expect(
    page.getByRole("combobox", { name: "To project" }).locator("option"),
  ).toHaveText(labels);
  await page.screenshot({ path: ".cache/ssh-project-selection-en.png" });
  state.projects[0].cwd = "/workspace/" + "nested-project-directory/".repeat(8) + "app";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await openKey(page, "Deployment key");
  await expect(card(page, "Deployment key")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("project filter scopes creation and host keys to the selected owner", async ({
  page,
}) => {
  const state = await fixture(page);
  state.keys = [
    { ...state.keys[0], id: "global-key", name: "Global key", projectId: null },
    { ...state.keys[0], id: "app-key", name: "App key", projectId: "project-app" },
    { ...state.keys[0], id: "docs-key", name: "Docs key", projectId: "project-docs" },
  ];
  state.accesses = [
    {
      ...state.access,
      id: "app-host",
      name: "App host",
      keyId: "app-key",
      projectId: "project-app",
    },
    {
      ...state.access,
      id: "docs-host",
      name: "Docs host",
      keyId: "docs-key",
      projectId: "project-docs",
    },
  ];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/settings/ssh");

  await page
    .getByRole("combobox", { name: "Project filter" })
    .selectOption("project-app");
  await expect(page.getByRole("button", { name: "App host", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Docs host", exact: true })).toHaveCount(
    0,
  );
  await showKeys(page);
  await expect(page.getByRole("button", { name: "App key", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Global key", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Docs key", exact: true })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Owner" })).toHaveValue("project-app");
  await page.getByLabel("Name", { exact: true }).fill("App deploy");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(
    state.calls.find((call) => call.path === "/api/ssh-keys" && call.method === "POST")
      .body,
  ).toMatchObject({
    name: "App deploy",
    projectId: "project-app",
  });

  await showAccesses(page);
  await page.getByRole("button", { name: "Add access", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Owner" })).toHaveValue("project-app");
  await expect(
    page.getByRole("combobox", { name: "SSH key" }).locator("option"),
  ).toHaveText(["Select a saved SSH key", "App key", "App deploy"]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("private key download stays out of rendered content and project reassignment surfaces collisions", async ({
  page,
}) => {
  const state = await fixture(page);
  state.keys = [{ ...state.keys[0], projectId: "project-app" }];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");

  await openKey(page, "Deployment key");
  const download = page.waitForEvent("download");
  await card(page, "Deployment key")
    .getByRole("button", { name: "Download private key" })
    .click();
  expect((await download).suggestedFilename()).toBe("agentpier-key-one.key");
  await expect(page.getByText("fixture-private-key", { exact: true })).toHaveCount(0);
  await expect(card(page, "Deployment key")).toContainText("Agent app");
  await expect(card(page, "Deployment key")).toContainText(
    "The download contains the unencrypted private key.",
  );

  await page.getByRole("button", { name: "Reassign project resources" }).click();
  await page.getByRole("combobox", { name: "From project" }).selectOption("project-app");
  await page.getByRole("combobox", { name: "To project" }).selectOption("project-docs");
  state.fail = true;
  await page.getByRole("button", { name: "Reassign", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The target project already has matching SSH resources.",
  );
});

test("inherited project accesses are visibly managed by the project and cannot be toggled", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [{ ...state.access, projectId: "project-app" }];
  state.inheritedIds = [state.access.id];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/sessions/fixture-session");
  await page.getByRole("button", { name: "SSH accesses", exact: true }).click();
  const inherited = page.getByRole("checkbox", { name: /Build server/ });
  await expect(inherited).toBeChecked();
  await expect(inherited).toBeDisabled();
  await expect(page.getByText("Project managed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Manage project accesses" }),
  ).toHaveAttribute("href", "/settings/ssh");
});

test("failed project metadata can be retried without leaving creation disabled", async ({
  page,
}) => {
  const state = await fixture(page);
  let attempts = 0;
  await page.route("**/api/ssh-projects", (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: "Project catalog offline" } })
      : route.fulfill({ json: { projects: state.projects } });
  });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  await expect(page.getByRole("alert")).toContainText("Project catalog offline");
  await showKeys(page);
  await expect(page.getByRole("button", { name: "Add SSH key" })).toBeDisabled();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Add SSH key" })).toBeEnabled();
  expect(attempts).toBe(2);
});

test("missing project metadata never presents owned resources as global and remains reassignable", async ({
  page,
}) => {
  const state = await fixture(page);
  state.projects = [
    { id: "project-docs", name: "Docs", cwd: "/work/docs", kind: "directory" },
  ];
  state.keys = [
    { ...state.keys[0], projectId: "missing-app" },
    { ...state.keys[0], id: "key-two", name: "Other key", projectId: "missing-other" },
  ];
  state.accesses = [
    { ...state.access, projectId: "missing-app" },
    {
      ...state.access,
      id: "ssh-two",
      name: "Other host",
      keyId: "key-two",
      projectId: "missing-other",
    },
  ];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  await page
    .getByRole("combobox", { name: "Project filter" })
    .selectOption("missing-app");
  await expect(
    page.getByRole("button", { name: "Add access", exact: true }),
  ).toBeDisabled();
  await showKeys(page);
  await expect(
    page.getByRole("button", { name: "Add SSH key", exact: true }),
  ).toBeDisabled();
  await openKey(page, "Deployment key");
  await expect(card(page, "Deployment key")).toContainText(
    "Unavailable project · missing-app",
  );
  await openAccess(page, "Build server");
  await expect(card(page, "Build server")).toContainText(
    "Unavailable project · missing-app",
  );
  await page.getByRole("button", { name: "Reassign project resources" }).click();
  await expect(page.getByRole("combobox", { name: "From project" })).toHaveValue(
    "missing-app",
  );
  await expect(
    page.getByRole("combobox", { name: "From project" }).locator("option"),
  ).toHaveText([
    "Unavailable project · missing-app",
    "Unavailable project · missing-other",
  ]);
  await expect(
    page.getByRole("combobox", { name: "To project" }).locator("option"),
  ).toHaveText(["Docs"]);
  await expect(page.getByRole("combobox", { name: "To project" })).toHaveValue(
    "project-docs",
  );
});

test("an explicit grant can be removed while inherited access stays active", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  state.accesses = [{ ...state.access, projectId: "project-app" }];
  state.inheritedIds = [state.access.id];
  state.assignedIds = [state.access.id];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/sessions/fixture-session");
  await page.getByRole("button", { name: "SSH accesses", exact: true }).click();
  await expect(
    page.getByText("Explicit session assignment", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Project managed", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".cache/ssh-dual-assignment-mobile-en.png" });
  await page.getByRole("button", { name: "Remove explicit assignment" }).click();
  const inherited = page.getByRole("checkbox", { name: /Build server/ });
  await expect(inherited).toBeChecked();
  await expect(inherited).toBeDisabled();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(state.assignedIds).toEqual([]);
  state.inheritedIds = [];
  await page.reload();
  await page.getByRole("button", { name: "SSH accesses", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Build server/ })).not.toBeChecked();
});
