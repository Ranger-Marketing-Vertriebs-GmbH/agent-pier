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
  const input = page.getByRole("spinbutton", { name: "New token budget" });
  // A budget that does not cover the reported usage cannot be sent.
  await input.fill("1500");
  await expect(raise).toBeDisabled();
  await input.fill("5000");
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
  await page.getByRole("spinbutton", { name: "Neues Token-Budget" }).fill("4000");
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
  const budget = page.getByRole("spinbutton", { name: "Token budget (optional)" });
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
  await dialog
    .getByRole("spinbutton", { name: "Token budget (optional)" })
    .fill("100000");
  await dialog.getByRole("button", { name: "Start run", exact: true }).click();
  await expect
    .poll(
      () =>
        state.calls.find((c) => c.path === "/pipeline-runs" && c.method === "POST")?.body
          .tokenBudget,
    )
    .toBe(100000);
});
