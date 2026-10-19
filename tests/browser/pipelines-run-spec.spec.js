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
    changes: [
      { at: "2026-09-07T12:05:00Z", source: "turn", nodeId: "stage-one", restored: true },
      { at: "2026-09-07T12:06:00Z", source: "verification", restored: true },
      { at: "2026-09-07T12:07:00Z", source: "manual", restored: false },
    ],
    revisions: [
      { n: 1, at: "2026-09-07T12:01:00Z", source: "stage", nodeId: "spec", path: "a.md" },
      { n: 2, at: "2026-09-07T12:08:00Z", source: "owner", path: "b.md" },
    ],
  };
  run.executionLog = [
    {
      id: "turn-1",
      nodeId: "stage-one",
      kind: "kickoff",
      startedAt: "2026-09-07T12:02:00Z",
      finishedAt: "2026-09-07T12:05:00Z",
      specChanged: "failed",
    },
  ];
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
  await expect(spec).toContainText("Nach dem Einfrieren 3× geändert");
  await expect(spec).toContainText("konnte nicht wiederhergestellt werden");
  // Each change names its source: the stage's turn, a verification or a manual edit.
  await spec.locator(".run-spec-history").first().locator("summary").click();
  const changes = spec.locator(".run-spec-history").first().locator("li");
  await expect(changes).toHaveCount(3);
  await expect(changes.nth(0)).toContainText("Planer");
  await expect(changes.nth(1)).toContainText("Prüfung");
  await expect(changes.nth(2)).toContainText("Außerhalb eines Turns bearbeitet");
  await expect(changes.nth(2)).toContainText("Konnte nicht wiederhergestellt werden");
  // Every revision stays readable.
  await spec.getByText("Fassungen · 2").click();
  await spec.getByRole("button", { name: "Spec-Fassung 1 anzeigen" }).click();
  const revision = page.getByRole("dialog", { name: "Spec-Fassung 1" });
  await expect(revision.locator("pre")).toHaveText("Revision 1 text");
  await expect(revision).toContainText("Nach Abschluss der Stufe geändert");
  await revision.getByRole("button", { name: "Dialog schließen" }).click();
  const criteria = spec.locator(".run-spec-criteria > li");
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
  await expect(detail).toContainText("Hat die Spec geändert; nicht wiederhergestellt");
});

test("after a rejected spec the gate offers to supply one", async ({ page }) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.actions = [...run.actions, "replace-spec"];
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  const spec = page.locator(".run-spec");
  await expect(spec).toContainText("Die Spec der Stufe wurde abgelehnt.");
  await spec.getByRole("button", { name: "Spec ersetzen" }).click();
  const editor = page.getByRole("dialog", { name: "Spec ersetzen" });
  await expect(editor.getByLabel("Spec")).toHaveValue("");
});

test("the spec reads in English", async ({ page }) => {
  const { spec } = await openSpecRun(page, { language: "en" });
  await expect(spec).toContainText("Frozen");
  await expect(spec).toContainText("Written by Planer");
  await expect(spec).toContainText("Changed 3× after it froze");
  await expect(spec).toContainText("the recorded text could not be restored");
  await expect(spec).toContainText("Revisions · 2");
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
