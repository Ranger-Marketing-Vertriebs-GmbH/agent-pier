import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

const SPEC_TEXT = "# Spec\n\n## Acceptance criteria\n1. Empty input is rejected.\n";

// A run whose spec stage passed and whose build stage waits at its gate.
async function openSpecRun(page, { language } = {}) {
  if (language)
    await page.addInitScript(
      (value) => localStorage.setItem("agentpier-language", value),
      language,
    );
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.nodes.unshift({
    ...run.nodes[0],
    id: "spec",
    status: "passed",
    verdict: { result: "pass", summary: "Spec written", findings: [] },
  });
  run.nodes[1].verdict = {
    result: "pass",
    summary: "Built",
    findings: [{ severity: "low", title: "Edge case", criterion: "AC2" }],
    criteria: [
      { criterion: "AC1", status: "met", evidence: "npm test passes" },
      { criterion: "AC2", status: "not-met", evidence: "list stays empty" },
    ],
  };
  run.actions = [...run.actions, "replace-spec"];
  run.spec = {
    path: ".pipeline/reports/spec/attempt-1/spec.md",
    nodeId: "spec",
    attemptId: "attempt-1",
    source: "stage",
    frozen: true,
    text: SPEC_TEXT,
    criteria: [
      { id: "AC1", text: "Empty input is rejected.", verify: "npm test" },
      { id: "AC2", text: "Valid input is stored." },
    ],
    assumptions: [
      { id: "A1", text: "Rejected input shows no message.", productDecision: true },
      { id: "A2", text: "The API stays the same.", productDecision: false },
    ],
    changes: [{ at: "2026-09-07T12:05:00Z", nodeId: "stage-one", restored: true }],
  };
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  return { state, spec: page.locator(".run-spec") };
}

test("the spec is shown at the top of the run view", async ({ page }) => {
  const { state, spec } = await openSpecRun(page);
  await expect(spec.getByRole("heading", { name: "Spec" })).toBeVisible();
  // Above the stages, below the run header.
  const top = await spec.boundingBox();
  const stages = await page.locator(".run-detail-layout").boundingBox();
  expect(top.y + top.height).toBeLessThanOrEqual(stages.y);
  await expect(spec).toContainText("Eingefroren");
  await expect(spec).toContainText(".pipeline/reports/spec/attempt-1/spec.md");
  await expect(spec).toContainText("Nach dem Einfrieren 1× geändert");
  const criteria = spec.locator(".run-spec-items").first().locator("li");
  await expect(criteria).toHaveCount(2);
  await expect(criteria.nth(0)).toContainText("AC1");
  await expect(criteria.nth(0)).toContainText("Empty input is rejected.");
  await expect(criteria.nth(0)).toContainText("So prüfen: npm test");
  await spec.getByText("Annahmen · 2 · Produktentscheidungen · 1").click();
  await expect(spec).toContainText("Produktentscheidung");

  await spec.getByRole("button", { name: "Spec anzeigen" }).click();
  const viewer = page.getByRole("dialog", { name: "Spec" });
  await expect(viewer.locator("pre")).toHaveText(SPEC_TEXT);
  await viewer.getByRole("button", { name: "Dialog schließen" }).click();

  // The owner replaces the spec at the gate.
  await spec.getByRole("button", { name: "Spec ersetzen" }).click();
  const editor = page.getByRole("dialog", { name: "Spec ersetzen" });
  await editor.getByLabel("Spec").fill("# Spec\n\n## Acceptance criteria\n1. Owner\n");
  await editor.getByRole("button", { name: "Ersetzen" }).click();
  await expect(editor).toBeHidden();
  expect(state.calls.filter((call) => call.path.endsWith("/gate")).at(-1).body).toEqual({
    action: "replace-spec",
    spec: "# Spec\n\n## Acceptance criteria\n1. Owner\n",
  });
});

test("a stage reports on the acceptance criteria by number", async ({ page }) => {
  await openSpecRun(page);
  await page.locator(".run-stage-rail").getByText("Planer").nth(1).click();
  const detail = page.locator(".run-stage-detail");
  await expect(detail).toContainText("Akzeptanzkriterien · 2");
  await expect(detail).toContainText("Erfüllt");
  await expect(detail).toContainText("npm test passes");
  await expect(detail).toContainText("Nicht erfüllt");
  await expect(detail).toContainText("Kriterium AC2");
});

test("the spec reads in English", async ({ page }) => {
  const { spec } = await openSpecRun(page, { language: "en" });
  await expect(spec).toContainText("Frozen");
  await expect(spec).toContainText("Written by Planer");
  await expect(spec).toContainText("Changed 1× after it froze");
  await expect(spec).toContainText("Acceptance criteria · 2");
  await expect(spec).toContainText("Verify: npm test");
  await expect(spec).toContainText("Assumptions · 2 · product decisions · 1");
  await expect(spec.getByRole("button", { name: "Show spec" })).toBeVisible();
  await expect(spec.getByRole("button", { name: "Replace spec" })).toBeVisible();
  const detail = page.locator(".run-stage-detail");
  await expect(detail).toContainText("Acceptance criteria · 2");
  await expect(detail).toContainText("Not met");
  await expect(detail).toContainText("Criterion AC2");
  // The long spec path wraps on a phone instead of widening the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(spec).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
