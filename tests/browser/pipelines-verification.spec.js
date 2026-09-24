import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";

const tests = { name: "Tests", command: "npm test", timeoutMs: 120000, blocking: true };
const projectItem = (page, name) =>
  page
    .getByRole("navigation", { name: "Projekte", exact: true })
    .getByRole("button", { name: new RegExp(`^${name}`) });
const lint = { name: "Lint", command: "npm run lint", timeoutMs: 60000, blocking: false };

test("desktop verification selects the first project and edits steps as rows", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.projects.push({ id: "project-two", name: "Zweites", cwd: "/fixture/two" });
  state.steps = [tests, lint];
  await openPipelines(page, "verification");
  await expect(page).toHaveURL(/\/pipelines\/verification\/project-one$/);
  const list = page.getByRole("navigation", { name: "Projekte", exact: true });
  const first = list.getByRole("button", { name: /^Projekt/ });
  await expect(first).toHaveAttribute("aria-current", "true");
  // Only the opened project reports its step count; no request per project.
  await expect(first).toContainText("2 Prüfschritte");
  await expect(list.getByRole("button", { name: /^Zweites/ })).not.toContainText(
    "Prüfschritt",
  );
  expect(
    state.calls.filter((c) => c.path.startsWith("/pipeline-verification/")),
  ).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Projekt", exact: true })).toBeVisible();
  const command = page.getByLabel("Prüfschritt 1: Befehl", { exact: true });
  await expect(command).toHaveValue("npm test");
  await expect(command).toHaveCSS("color", "rgb(255, 201, 157)");
  expect(await command.evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(
    /monospace/,
  );
  await expect(page.locator(".verification-columns")).toContainText("Zeitlimit (s)");
  await expect(page.locator(".verification-step-number").first()).toHaveText("1");
  await page.getByRole("button", { name: "Nach unten 1", exact: true }).click();
  await expect(command).toHaveValue("npm run lint");
  await expect(
    page.getByRole("button", { name: "Nach oben 1", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect
    .poll(() => state.steps.map((step) => step.name))
    .toEqual(["Lint", "Tests"]);
});

test("unsaved verification steps ask before another project opens", async ({ page }) => {
  const state = await pipelinesFixture(page);
  state.projects.push({ id: "project-two", name: "Zweites", cwd: "/fixture/two" });
  await openPipelines(page, "verification/project-one");
  await page.getByRole("button", { name: "Prüfschritt hinzufügen", exact: true }).click();
  await page.getByLabel("Prüfschritt 1: Name", { exact: true }).fill("Tests");
  const confirm = page.getByRole("dialog", { name: "Aktion bestätigen" });
  await projectItem(page, "Zweites").click();
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(page).toHaveURL(/\/verification\/project-one$/);
  await expect(page.getByLabel("Prüfschritt 1: Name", { exact: true })).toHaveValue(
    "Tests",
  );
  await projectItem(page, "Zweites").click();
  await confirm.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(page).toHaveURL(/\/verification\/project-two$/);
  await expect(page.getByRole("heading", { name: "Zweites", exact: true })).toBeVisible();
});

test("verification registers a project above the list and opens it", async ({ page }) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "verification");
  await expect(page).toHaveURL(/\/verification\/project-one$/);
  await page.getByText("Projekt hinzufügen", { exact: true }).first().click();
  await page
    .getByRole("textbox", { name: "Projektordner registrieren", exact: true })
    .fill("/fixture/new");
  await page.getByRole("button", { name: "Projekt hinzufügen", exact: true }).click();
  await expect(page).toHaveURL(/\/verification\/project-registered$/);
  await expect(projectItem(page, "Registered")).toHaveAttribute("aria-current", "true");
  expect(
    state.calls.find((c) => c.path === "/memory/projects" && c.method === "POST").body,
  ).toEqual({ cwd: "/fixture/new" });
});

test("mobile verification shows the project list first without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  state.steps = [tests];
  await openPipelines(page, "verification");
  const item = projectItem(page, "Projekt");
  await expect(item).toBeVisible();
  await expect(page).toHaveURL(/\/pipelines\/verification$/);
  await item.click();
  await expect(page).toHaveURL(/\/verification\/project-one$/);
  await expect(page.getByLabel("Prüfschritt 1: Befehl", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Alle Projekte", exact: true }).click();
  await expect(item).toBeVisible();
});

test.describe("English verification", () => {
  test.use({ locale: "en-GB" });
  test("project list and step rows use English copy", async ({ page }) => {
    const state = await pipelinesFixture(page);
    state.steps = [tests];
    await openPipelines(page, "verification/project-one");
    await expect(
      page.getByRole("navigation", { name: "Projects", exact: true }).getByRole("button"),
    ).toContainText("1 verification step");
    await expect(page.locator(".verification-columns")).toContainText("Timeout (s)");
    await expect(
      page.getByLabel("Verification step 1: command", { exact: true }),
    ).toHaveValue("npm test");
    await expect(
      page.getByRole("button", { name: "Add verification step", exact: true }),
    ).toBeVisible();
  });
});
