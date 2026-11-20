import { test, expect } from "../helpers/browser-test.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

// Pipelines polish (AGENTPIER-430).
const english = (page) =>
  page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));

test("a verification step without output says so with its exit code", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.nodes[0].verifyResult = {
    status: "failed",
    steps: [{ name: "lint", exitCode: 2, blocking: true }],
  };
  state.runs.push(run);
  await page.route("**/verify-logs/*", (route) =>
    route.fulfill({ json: { log: "", truncated: false } }),
  );
  await openPipelines(page, "runs/run-one");
  await page.getByRole("button", { name: /lint/ }).first().click();
  await expect(page.getByRole("dialog")).toContainText("No output (exit code 2).");
});

test("a start run budget out of range gets the range inline", async ({ page }) => {
  await english(page);
  await pipelinesFixture(page);
  await openPipelines(page, "runs/new");
  const dialog = page.getByRole("dialog", { name: "Start run" });
  const budget = dialog.getByRole("textbox", { name: "Token budget (optional)" });
  for (const value of ["abc", "0"]) {
    await budget.fill(value);
    await expect(dialog.getByText("Enter a whole number from 1 to")).toBeVisible();
    await expect(budget).toHaveAttribute("aria-invalid", "true");
    await expect(
      dialog.getByRole("button", { name: "Start run", exact: true }),
    ).toBeDisabled();
  }
  await budget.fill("5000");
  await expect(dialog.getByText("Enter a whole number from 1 to")).toHaveCount(0);
});

test("Active at most 0 becomes 1 and says the range", async ({ page }) => {
  await english(page);
  await pipelinesFixture(page);
  await openPipelines(page, "queue/project-one");
  const limit = page.getByRole("spinbutton", { name: "Active at most" });
  await limit.fill("0");
  await expect(page.getByText("From 1 to 20.")).toBeVisible();
  await expect(limit).toHaveValue("1");
  await expect(limit).toHaveAccessibleDescription("From 1 to 20.");
  await limit.fill("3");
  await expect(page.getByText("From 1 to 20.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save settings" })).toBeEnabled();
});

test("an autonomous profile marks its starting instructions as required", async ({
  page,
}) => {
  await english(page);
  await pipelinesFixture(page);
  await openPipelines(page);
  await page
    .getByRole("button", { name: /^Edit: / })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Starting instructions (required)", exact: true }),
  ).toBeVisible();
});

test("the definition's name and description sit right under their labels", async ({
  page,
}) => {
  await english(page);
  await pipelinesFixture(page);
  await openPipelines(page, "definitions/pipeline-one");
  for (const name of ["Pipeline name", "Description"]) {
    const field = page
      .locator(".definition-head")
      .getByRole("textbox", { name, exact: true });
    const label = field.locator("xpath=ancestor::label[1]");
    const [fieldBox, labelBox] = await Promise.all([
      field.boundingBox(),
      label.boundingBox(),
    ]);
    // The label text is one line above the field, not 50 px.
    expect(fieldBox.y - labelBox.y).toBeLessThan(30);
    expect(fieldBox.height).toBeLessThan(60);
  }
});
