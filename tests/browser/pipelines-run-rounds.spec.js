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
      ],
    },
  ];
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  return page.locator(".run-rounds > li");
}

test("the run view shows the loop rounds as a timeline", async ({ page }) => {
  const rounds = await openRounds(page);
  await expect(rounds).toHaveCount(2);
  await expect(rounds.nth(0)).toContainText("Runde 1");
  await expect(rounds.nth(0)).toContainText("Befunde · 2");
  await expect(rounds.nth(0)).toContainText("Behoben 1 · Bestritten 1");
  await expect(rounds.nth(1)).toContainText("Runde 2");
  await expect(rounds.nth(1)).toContainText("Befunde · 1");
  await expect(rounds.nth(1)).not.toContainText("Behoben");
});

test("the loop round timeline reads in English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const rounds = await openRounds(page);
  await expect(page.getByText("Rounds", { exact: true })).toBeVisible();
  await expect(rounds.nth(0)).toContainText("Round 1");
  await expect(rounds.nth(0)).toContainText("Findings · 2");
  await expect(rounds.nth(0)).toContainText("Fixed 1 · Disputed 1");
});
