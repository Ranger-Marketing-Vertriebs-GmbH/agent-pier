import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";
function sampleRun(state, id = "run-one") {
  return {
    id,
    pipelineId: "pipeline-one",
    pipelineName: "Entwicklungsablauf",
    projectId: "project-one",
    cwd: "/fixture/project",
    task: "Review the application",
    status: "awaiting-human",
    currentNodeId: "stage-one",
    usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
    nodes: [
      {
        id: "stage-one",
        profileSnapshot: state.profiles[0],
        status: "awaiting-gate",
        sessionId: "stage-session",
        startedAt: "2026-09-07T12:00:00Z",
        verdict: {
          result: "fail",
          summary: "Review requires changes",
          findings: [
            {
              severity: "high",
              title: "Missing validation",
              detail: "Validate the input",
            },
          ],
        },
        verifyResult: { steps: [{ name: "Check", exitCode: 1, blocking: true }] },
      },
    ],
    actions: ["accept", "feedback", "loop-back", "override", "abort", "reconcile"],
    executionLog: [],
  };
}
test("run detail offers engine-authorized decisions and reads exact evidence without losing failed feedback", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  await openPipelines(page, "runs/run-one");
  await expect(page.getByText("Missing validation", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stufe erneut starten", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Chat öffnen", exact: true }),
  ).toHaveAttribute("href", "/sessions/stage-session/chat");
  await expect(page.getByRole("group", { name: "Gemeldete Nutzung" })).toContainText(
    "1.500",
  );
  await page.getByRole("button", { name: "Änderungen", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("+new line");
  await expect(page.getByRole("dialog")).toContainText("Ausgabe gekürzt.");
  await page.getByRole("button", { name: "Dialog schließen" }).click();
  await page.getByRole("button", { name: "Dateien", exact: true }).click();
  await page.getByRole("button", { name: "Prüfbericht", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Fixture report evidence");
  await page.getByRole("button", { name: "Dialog schließen" }).click();
  await page.getByRole("button", { name: "Verifikationsprotokoll", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Fixture verification log");
  await page.getByRole("button", { name: "Dialog schließen" }).click();
  await page.getByLabel("Rückmeldung", { exact: true }).fill("Please fix validation");
  state.fail = "/pipeline-runs/run-one/gate";
  await page
    .getByRole("button", { name: "Mit Rückmeldung wiederholen", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(page.getByLabel("Rückmeldung", { exact: true })).toHaveValue(
    "Please fix validation",
  );
  state.fail = "";
  await page
    .getByRole("button", { name: "Mit Rückmeldung wiederholen", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mit Rückmeldung wiederholen", exact: true }),
  ).toHaveCount(0);
  expect(state.calls.filter((call) => call.path.endsWith("/gate")).at(-1).body).toEqual({
    action: "feedback",
    feedback: "Please fix validation",
  });
});
test("run pagination and status filters survive reload and retain exact run identity", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.runs = Array.from({ length: 21 }, (_, index) => ({
    ...sampleRun(state, "run-" + index),
    task: "Task " + index,
    status: index === 20 ? "failed" : "completed",
    actions: ["delete"],
  }));
  await openPipelines(page, "runs");
  await page.getByRole("button", { name: "Läufe: Nächste Seite", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(
    page.getByRole("button", { name: "Lauf öffnen: Task 20", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Lauf öffnen: Task 20", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Status", { exact: true }).selectOption("failed");
  await expect(page).toHaveURL(/status=failed$/);
  await expect(page).not.toHaveURL(/page=2/);
  await page.getByRole("button", { name: "Lauf öffnen: Task 20", exact: true }).click();
  await expect(page).toHaveURL(/runs\/run-20/);
  await page.getByRole("button", { name: "Lauf löschen", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Lauf löschen", exact: true })
    .click();
  await expect(
    page.getByText("Noch keine passenden Läufe.", { exact: true }),
  ).toBeVisible();
});
test("mobile run creation suppresses duplicate submissions and opens the persisted run", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  await openPipelines(page, "runs/new");
  await page.getByLabel("Pipelinename", { exact: true }).selectOption("pipeline-one");
  await page.getByLabel("Arbeitsverzeichnis", { exact: true }).fill("/fixture/project");
  await page
    .getByLabel("Aufgabe", { exact: true })
    .fill("A long task " + "details ".repeat(60) + "identifier".repeat(40));
  state.hold = "/pipeline-runs";
  await page.getByRole("button", { name: "Lauf starten", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Lauf starten", exact: true }),
  ).toBeDisabled();
  expect(
    state.calls.filter((c) => c.path === "/pipeline-runs" && c.method === "POST"),
  ).toHaveLength(1);
  state.hold = null;
  state.release();
  await expect(page).toHaveURL(/runs\/new-run$/);
  await expect(
    page.getByRole("button", { name: "Lauf abbrechen", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("manual loops accept optional feedback and display the actual iteration and unconfigured verification", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.actions = ["loop-back"];
  run.nodes[0].loop = { iteration: 1, maxIterations: 2 };
  run.nodes[0].verifyResult = { status: "not-configured", steps: [] };
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  await expect(
    page.getByText("Wartet auf Freigabe · 1 / 2", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Keine Verifikation konfiguriert.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Zur Reparatur zurückspringen", exact: true })
    .click();
  expect(state.calls.find((c) => c.path.endsWith("/gate")).body).toEqual({
    action: "loop-back",
    feedback: "",
  });
});
test("newly registered project supplies the run working directory", async ({ page }) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "runs/new");
  await page.getByLabel("Pipelinename", { exact: true }).selectOption("pipeline-one");
  await page.getByText("Projekt hinzufügen", { exact: true }).first().click();
  await page
    .getByLabel("Projektordner registrieren", { exact: true })
    .fill("/fixture/registered");
  await page.getByRole("button", { name: "Projekt hinzufügen", exact: true }).click();
  await expect(page.getByLabel("Arbeitsverzeichnis", { exact: true })).toHaveValue(
    "/fixture/registered",
  );
  await page.getByLabel("Aufgabe", { exact: true }).fill("Build registered project");
  await page.getByRole("button", { name: "Lauf starten", exact: true }).click();
  await expect(page).toHaveURL(/runs\/new-run$/);
  expect(
    state.calls.find((c) => c.path === "/pipeline-runs" && c.method === "POST").body.cwd,
  ).toBe("/fixture/registered");
});

test("artifact groups remain scoped to the stage whose files were opened", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.nodes.push({
    ...structuredClone(run.nodes[0]),
    id: "stage-two",
    profileSnapshot: { ...structuredClone(state.profiles[0]), name: "Review" },
  });
  state.runs.push(run);
  await page.route("**/api/pipeline-runs/run-one/nodes/*/artifacts", (route) =>
    route.fulfill({
      json: {
        artifacts: [
          { nodeId: "stage-one", artifacts: [{ path: "plan.md", label: "Plan report" }] },
          {
            nodeId: "stage-two",
            artifacts: [{ path: "review.md", label: "Review report" }],
          },
        ],
      },
    }),
  );
  await openPipelines(page, "runs/run-one");
  const stages = page.locator(".pipeline-timeline > li");
  await stages.nth(0).getByRole("button", { name: "Dateien", exact: true }).click();
  await expect(
    stages.nth(0).getByRole("button", { name: "Plan report", exact: true }),
  ).toBeVisible();
  await expect(
    stages.nth(0).getByRole("button", { name: "Review report", exact: true }),
  ).toHaveCount(0);
  await stages.nth(1).getByRole("button", { name: "Dateien", exact: true }).click();
  await expect(
    stages.nth(1).getByRole("button", { name: "Plan report", exact: true }),
  ).toHaveCount(0);
  await stages.nth(1).getByRole("button", { name: "Review report", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Fixture report evidence");
  expect(state.calls.find((call) => call.path.endsWith("/artifact")).path).toBe(
    "/pipeline-runs/run-one/nodes/stage-two/artifact",
  );
});
