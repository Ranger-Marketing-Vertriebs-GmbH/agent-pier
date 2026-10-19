import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

const finding = (id, title) => ({ id, severity: "high", title });
async function openRounds(page) {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.nodes.push({ ...run.nodes[0], id: "stage-two", status: "pending" });
  run.loopRounds = [
    {
      edge: "stage-two->stage-one",
      round: 1,
      fromNodeId: "stage-two",
      toNodeId: "stage-one",
      at: "2026-09-07T12:10:00Z",
      stages: [
        {
          nodeId: "stage-two",
          result: "fail",
          summary: "Needs work",
          findings: [finding("R1-1", "Missing validation"), finding("R1-2", "Typo")],
          reports: [],
        },
      ],
      repairAttemptId: "attempt-2",
      responses: [
        { finding: "R1-1", status: "fixed" },
        { finding: "R1-2", status: "disputed", reason: "Intended" },
      ],
    },
    {
      edge: "stage-two->stage-one",
      round: 2,
      fromNodeId: "stage-two",
      toNodeId: "stage-one",
      at: "2026-09-07T12:20:00Z",
      stages: [
        {
          nodeId: "stage-two",
          result: "fail",
          summary: "Still broken",
          findings: [finding("R2-1", "Broken error message")],
          reports: [],
        },
        {
          nodeId: "stage-one",
          result: "pass",
          summary: "Tests green",
          findings: [{ ...finding("R2-2", "Slow suite"), severity: "low" }],
          reports: [],
        },
      ],
      repairAttemptId: "attempt-3",
      responses: [{ finding: "R2-1", status: "not-fixed", reason: "Needs a migration" }],
    },
    {
      edge: "stage-two->stage-one",
      round: 3,
      fromNodeId: "stage-two",
      toNodeId: "stage-one",
      at: "2026-09-07T12:30:00Z",
      operatorNote: "Once more",
      stages: [
        {
          nodeId: "stage-two",
          result: "pass",
          summary: "Fine",
          findings: [],
          reports: [],
        },
      ],
    },
    {
      edge: "stage-two->stage-one",
      round: 4,
      fromNodeId: "stage-two",
      toNodeId: "stage-one",
      at: "2026-09-07T12:40:00Z",
      stages: [
        {
          nodeId: "stage-two",
          result: "fail",
          summary: "Two more",
          findings: [finding("R4-1", "Leaky handle"), finding("R4-2", "Wrong label")],
          reports: [],
        },
      ],
      // The repair was asked for its missing answers and is still running.
      answersNudged: true,
      responses: [{ finding: "R4-1", status: "fixed" }],
    },
  ];
  run.executionLog = [
    {
      id: "turn-1",
      nodeId: "stage-one",
      kind: "verdict-nudge",
      startedAt: "2026-09-07T12:41:00Z",
      finishedAt: "2026-09-07T12:42:00Z",
      verdict: { result: "pass", summary: "Repaired", ignoredAnswers: ["R9-9"] },
    },
  ];
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  return page.locator(".run-rounds > li");
}

test("the run view shows the loop rounds as a timeline", async ({ page }) => {
  const rounds = await openRounds(page);
  await expect(rounds).toHaveCount(4);
  await expect(rounds.nth(0)).toContainText("Runde 1");
  await expect(rounds.nth(0)).toContainText("Befunde · 2");
  await expect(rounds.nth(0)).toContainText("Behoben 1 · Bestritten 1");
  await expect(rounds.nth(1)).toContainText("Runde 2");
  await expect(rounds.nth(1)).toContainText("Befunde · 2");
  await expect(rounds.nth(1)).toContainText("Nicht behoben 1");
  // The result is named, not only coloured.
  await expect(rounds.nth(0).getByRole("img", { name: "Fehlgeschlagen" })).toBeVisible();
  await expect(rounds.nth(2).getByRole("img", { name: "Bestanden" })).toBeVisible();
  // A round without findings has nothing to open.
  await expect(rounds.nth(2).locator("details")).toHaveCount(0);

  // A round opens to its findings with the repair turn's answers.
  const second = rounds.nth(1).locator(".run-findings > li");
  await expect(second.first()).toBeHidden();
  await rounds.nth(1).locator("summary").click();
  await expect(second).toHaveCount(2);
  await expect(second.nth(0)).toContainText("Broken error message");
  await expect(second.nth(0)).toContainText("Nicht behoben: Needs a migration");
  await expect(second.nth(1)).toContainText("Slow suite");
  await expect(second.nth(1)).toContainText("Nicht beantwortet");
  // The newest round's repair may still answer: pending, not unanswered.
  await rounds.nth(3).locator("summary").click();
  const pending = rounds.nth(3).locator(".run-findings > li");
  await expect(pending.nth(0)).toContainText("Behoben");
  await expect(pending.nth(1)).toContainText("Antwort ausstehend");
  await expect(pending.nth(1)).not.toContainText("Nicht beantwortet");
  // Answers to unknown findings are noted in the run history.
  await page.locator(".run-execution-log > summary").click();
  await expect(page.locator(".run-execution-log")).toContainText(
    "Antworten auf unbekannte Befunde wurden ignoriert: R9-9",
  );
  await rounds.nth(0).locator("summary").click();
  await expect(rounds.nth(0).locator(".run-findings > li").nth(1)).toContainText(
    "Bestritten: Intended",
  );
});

test("the loop round timeline reads in English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const rounds = await openRounds(page);
  await expect(page.getByText("Rounds", { exact: true })).toBeVisible();
  await expect(rounds.nth(0)).toContainText("Round 1");
  await expect(rounds.nth(0)).toContainText("Findings · 2");
  await expect(rounds.nth(0)).toContainText("Fixed 1 · Disputed 1");
  await expect(rounds.nth(0).getByRole("img", { name: "Failed" })).toBeVisible();
  await rounds.nth(1).locator("summary").click();
  const findings = rounds.nth(1).locator(".run-findings > li");
  await expect(findings.nth(0)).toContainText("Not fixed: Needs a migration");
  await expect(findings.nth(1)).toContainText("Not answered");
  await rounds.nth(3).locator("summary").click();
  await expect(rounds.nth(3).locator(".run-findings > li").nth(1)).toContainText(
    "Answer pending",
  );
  await page.locator(".run-execution-log > summary").click();
  await expect(page.locator(".run-execution-log")).toContainText(
    "Answers to unknown findings were ignored: R9-9",
  );
});
