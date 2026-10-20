import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";
import { inboxFixture } from "./inbox-fixture.js";

const english = (page) =>
  page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
const gateBody = (state) =>
  state.calls.find((call) => call.path === "/pipeline-runs/run-one/gate")?.body;

// A run whose reported 1,500 tokens are above its budget of 1,000.
function budgetRun(state) {
  const run = sampleRun(state);
  run.tokenBudget = 1000;
  run.nodes[0].verdict = undefined;
  run.nodes[0].verifyResult = undefined;
  run.nodes[0].failReason = "budget-exceeded";
  // The engine stores its German message; an English page must show it in English.
  run.nodes[0].failDetail =
    "Der Lauf hat sein Token-Budget überschritten. Ein neuer Turn startet erst, wenn das Budget erhöht wird.";
  run.actions = ["abort", "raise-budget"];
  state.runs.push(run);
  return run;
}

test("a run above its budget shows its usage and continues with a higher budget", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  budgetRun(state);
  await openPipelines(page, "runs/run-one");
  await expect(page.getByText("Token budget exceeded").first()).toBeVisible();
  await expect(
    page.getByText("No new turn starts until the budget is raised.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("The run's turns reported 1,500 tokens, above its budget of 1,000.", {
      exact: false,
    }),
  ).toBeVisible();
  const usage = page.getByRole("group", { name: "Reported usage" });
  await expect(usage).toContainText("Budget");
  await expect(usage).toContainText("1,500 of 1,000");
  const raise = page.getByRole("button", {
    name: "Raise budget and continue",
    exact: true,
  });
  await expect(raise).toHaveClass(/primary/);
  await expect(raise).toBeDisabled();
  const input = page.getByRole("textbox", { name: "New token budget" });
  // A budget that does not cover the reported usage cannot be sent.
  await input.fill("1500");
  await expect(raise).toBeDisabled();
  await expect(page.getByText("Enter a whole number from 1,501")).toBeVisible();
  // A valid value enables the primary button and it looks enabled: the disabled
  // dimming fades out within its 0.16 s transition.
  await input.fill("5000");
  await expect(raise).toBeEnabled();
  await expect(raise).toHaveClass(/\bprimary\b/);
  await expect.poll(() => raise.evaluate((b) => getComputedStyle(b).opacity)).toBe("1");
  await expect(page.getByText("Enter a whole number from 1,501")).toHaveCount(0);
  // The field is typed, not stepped: no native number spinners.
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await raise.click();
  await expect
    .poll(() => gateBody(state))
    .toEqual({ action: "raise-budget", tokenBudget: 5000 });
  // Stopping the run stays in the header.
  await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible();
});

test("the inbox shows the budget gate and raises the budget there", async ({ page }) => {
  const state = await inboxFixture(page);
  state.run.usage = { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 };
  state.run.tokenBudget = 2000;
  state.run.nodes[0].failReason = "budget-exceeded";
  state.run.actions = ["abort", "raise-budget"];
  await page.goto(baseURL + "/inbox/gate/run-one");
  await expect(page.getByText("Token-Budget überschritten")).toBeVisible();
  await expect(
    page.getByText("Die Turns des Laufs haben 2.500 Tokens gemeldet", { exact: false }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Neues Token-Budget" }).fill("4000");
  await page
    .getByRole("button", { name: "Budget erhöhen und fortsetzen", exact: true })
    .click();
  await expect
    .poll(() => gateBody(state))
    .toEqual({ action: "raise-budget", tokenBudget: 4000 });
});

test("a pipeline saves its token budget and a run start can replace it", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  await openPipelines(page, "definitions/pipeline-one");
  const budget = page.getByRole("textbox", { name: "Token budget (optional)" });
  await expect(budget).toHaveValue("");
  await budget.fill("250000");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => state.calls.find((c) => c.method === "PATCH")?.body.tokenBudget)
    .toBe(250000);

  await openPipelines(page, "runs/new");
  const dialog = page.getByRole("dialog", { name: "Start run" });
  await dialog.getByRole("radio", { name: "Entwicklungsablauf", exact: true }).check();
  await expect(dialog).toContainText(
    "Leave empty to use the pipeline's budget of 250,000 tokens.",
  );
  await dialog.getByLabel("Repository folder", { exact: true }).fill("/fixture/project");
  await dialog.getByLabel("Task", { exact: true }).fill("Build it");
  const runBudget = dialog.getByRole("textbox", { name: "Token budget (optional)" });
  await expect(runBudget).toHaveAttribute("inputmode", "numeric");
  await runBudget.fill("100000");
  await dialog.getByRole("button", { name: "Start run", exact: true }).click();
  await expect
    .poll(
      () =>
        state.calls.find((c) => c.path === "/pipeline-runs" && c.method === "POST")?.body
          .tokenBudget,
    )
    .toBe(100000);
});

test("at phone width the budget gate fits and the usage tiles leave no gap", async ({
  page,
}) => {
  await english(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  budgetRun(state);
  await openPipelines(page, "runs/run-one");
  const input = page.getByRole("textbox", { name: "New token budget" });
  await expect(input).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Raise budget and continue", exact: true }),
  ).toBeVisible();
  // An out-of-range value says why the button stays disabled.
  await input.fill("10");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Enter a whole number from 1,501 to 1,000,000,000."),
  ).toBeVisible();
  const usage = page.getByRole("group", { name: "Reported usage" });
  const tiles = usage.locator(":scope > div");
  await expect(tiles).toHaveCount(5);
  // The fifth tile spans both columns instead of leaving an empty cell.
  const [budgetBox, costBox] = [
    await tiles.nth(3).boundingBox(),
    await tiles.nth(4).boundingBox(),
  ];
  const usageBox = await usage.boundingBox();
  expect(costBox.width).toBeGreaterThan(budgetBox.width * 1.5);
  expect(Math.round(costBox.width)).toBeGreaterThanOrEqual(
    Math.round(usageBox.width) - 2,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("a run with a budget but no reported usage yet shows zero of its budget", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.usage = null;
  run.tokenBudget = 2000;
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  const usage = page.getByRole("group", { name: "Reported usage" });
  await expect(usage).toContainText("0 of 2,000");
});

test("the definition editor refuses a budget outside its range before saving", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  await openPipelines(page, "definitions/pipeline-one");
  const budget = page.getByRole("textbox", { name: "Token budget (optional)" });
  await budget.fill("0");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(await budget.evaluate((input) => input.validity.valid)).toBe(false);
  for (const text of ["1.5", "1e6", "1000000001"]) {
    await budget.fill(text);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(await budget.evaluate((input) => input.validity.valid)).toBe(false);
  }
  await expect(budget).toHaveAttribute("inputmode", "numeric");
  expect(state.calls.some((c) => c.method === "PATCH")).toBe(false);
});
