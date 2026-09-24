import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

test("run header shows the full working directory in monospace", async ({ page }) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.cwd = "/fixture/workspaces/client/project";
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  const cwd = page.locator(".run-header-cwd");
  await expect(cwd).toContainText("Arbeitsverzeichnis");
  await expect(cwd.locator("code")).toHaveText("/fixture/workspaces/client/project");
  const font = await cwd
    .locator("code")
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(font).toMatch(/mono/i);
});

test("reported usage is labelled as the whole run's usage", async ({ page }) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  await openPipelines(page, "runs/run-one");
  const usage = page.getByRole("group", { name: "Gemeldete Nutzung", exact: true });
  await expect(usage).toContainText("1.500");
  await expect(page.locator(".run-usage-block > h4")).toHaveText(
    "Gemeldete Nutzung · gesamter Lauf",
  );
});

test("reported usage stays visible for a run without stages, also in English", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.nodes = [];
  run.status = "failed";
  run.actions = ["delete"];
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  await expect(
    page.getByRole("heading", { name: "Review the application" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Reported usage", exact: true }),
  ).toContainText("1,500");
  await expect(page.locator(".run-usage-block > h4")).toHaveText(
    "Reported usage · whole run",
  );
  await expect(page.locator(".run-header-cwd")).toContainText("Working directory");
});
