import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";
const stageRail = (page) => page.getByRole("navigation", { name: "Stufen", exact: true });
const stageButtons = (page) => stageRail(page).getByRole("button");
const stageDetail = (page) => page.locator(".run-stage-detail");
const headerActions = (page) => page.locator(".run-header-actions");
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
// Three stages: planned (passed, loops nowhere), review (gate, verification, loop back
// to stage 1) and release (pull request), connected like the compiled run snapshot.
function threeStageRun(state) {
  const run = sampleRun(state);
  const profile = (name, cliTool = "codex") => ({
    ...structuredClone(state.profiles[0]),
    name,
    config: { ...structuredClone(state.profiles[0].config), cliTool },
  });
  run.currentNodeId = "review";
  run.createdAt = "2026-09-07T09:00:00Z";
  run.nodes = [
    {
      id: "plan",
      profileSnapshot: profile("Planer"),
      status: "passed",
      startedAt: "2026-09-07T10:00:00Z",
      finishedAt: "2026-09-07T10:30:00Z",
      gateDecision: "accepted",
      verdict: { result: "pass", summary: "Plan ready", findings: [] },
    },
    {
      ...run.nodes[0],
      id: "review",
      profileSnapshot: profile("Prüfer", "claude"),
    },
    { id: "release", profileSnapshot: profile("Veröffentlichung"), status: "pending" },
  ];
  run.entry = "plan";
  run.edges = [
    { from: "plan", to: "review", condition: "default", effects: {} },
    {
      from: "review",
      to: "release",
      condition: "default",
      effects: { humanGate: true, verify: true, createPr: false },
    },
    { from: "review", to: "plan", condition: "fail", maxIterations: 2, effects: {} },
    {
      from: "release",
      to: null,
      condition: "default",
      effects: { humanGate: false, verify: false, createPr: true },
    },
  ];
  run.executionLog = [
    {
      id: "attempt-plan",
      nodeId: "plan",
      kind: "stage",
      startedAt: "2026-09-07T10:00:00Z",
      finishedAt: "2026-09-07T10:30:00Z",
      verdict: { result: "pass", summary: "Plan ready" },
    },
    {
      id: "attempt-review",
      nodeId: "review",
      kind: "stage",
      startedAt: "2026-09-07T12:00:00Z",
      failReason: "verdict-fail",
    },
  ];
  return run;
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
  const stage = stageDetail(page).filter({ hasText: "Missing validation" });
  await stage.getByRole("button", { name: "Dateien", exact: true }).click();
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
  const detail = stageDetail(page);
  await stageButtons(page).nth(0).click();
  await detail.getByRole("button", { name: "Dateien", exact: true }).click();
  await expect(
    detail.getByRole("button", { name: "Plan report", exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "Review report", exact: true }),
  ).toHaveCount(0);
  await stageButtons(page).nth(1).click();
  await expect(
    detail.getByRole("heading", { name: "Review", exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "Plan report", exact: true }),
  ).toHaveCount(0);
  await detail.getByRole("button", { name: "Dateien", exact: true }).click();
  await expect(
    detail.getByRole("button", { name: "Plan report", exact: true }),
  ).toHaveCount(0);
  await detail.getByRole("button", { name: "Review report", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Fixture report evidence");
  expect(state.calls.find((call) => call.path.endsWith("/artifact")).path).toBe(
    "/pipeline-runs/run-one/nodes/stage-two/artifact",
  );
});

test("verification is visible during polling and long run text stays readable on desktop and mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.status = "running";
  run.actions = ["abort"];
  run.branch = "agentpier/verification-fixture";
  run.task = "## Implementation\n\n" + "Follow the project conventions. ".repeat(100);
  run.verifyJob = { id: "verification-one", startedAt: "2026-09-09T18:03:14Z" };
  run.nodes[0].status = "running";
  run.nodes[0].failDetail = "Old Git operation failed";
  run.nodes[0].verifyPending = true;
  run.nodes[0].verifyPlan = [{ name: "JavaScript tests" }, { name: "PHP tests" }];
  run.nodes[0].verifyResult = null;
  run.nodes[0].verdict = {
    result: "pass",
    summary: "Implemented the requested documentation changes. ".repeat(35),
    findings: [
      { severity: "low", title: "Existing database configuration needs review" },
    ],
  };
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  const verification = page.getByRole("region", { name: "Verifikation", exact: true });
  await expect(verification).toBeVisible();
  await expect(verification).toContainText("Verifikation läuft");
  await expect(verification).toContainText("Gestartet:");
  await expect(page.getByText("Old Git operation failed")).toHaveCount(0);
  await expect(
    page
      .locator(".run-header")
      .getByRole("heading", { name: "Implementation", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".run-header")).toContainText("Entwicklungsablauf");
  await expect(page.locator(".pipeline-prose")).toBeHidden();
  const rail = await page.locator(".run-stage-rail").boundingBox();
  const content = await stageDetail(page).boundingBox();
  expect(Math.round(rail.width)).toBe(280);
  expect(rail.x + rail.width).toBeLessThan(content.x);
  await page.getByText("Konfigurierte Prüfschritte (2)", { exact: true }).click();
  await expect(verification.getByText("JavaScript tests", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/pipeline-verification-desktop.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.locator(".pipeline-task > summary").click();
  await expect(
    page.locator(".pipeline-prose").getByRole("heading", { name: "Implementation" }),
  ).toBeVisible();
  await page.locator(".pipeline-task > summary").click();
  await page.getByText("Ergebniszusammenfassung anzeigen", { exact: true }).click();
  await expect(page.locator(".pipeline-verdict-summary > p")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByText("Ergebniszusammenfassung anzeigen", { exact: true }).click();
  await page.screenshot({
    path: "test-results/pipeline-verification-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
  run.verifyJob = null;
  run.nodes[0].verifyPending = false;
  run.nodes[0].status = "passed";
  run.status = "completed";
  run.actions = [];
  await expect(verification).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator(".run-header-status")).toHaveText("Abgeschlossen");
});

test("verification evidence distinguishes timeouts from unavailable results", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.nodes[0].verifyResult = {
    status: "timed-out",
    steps: [
      { name: "bootstrap", exitCode: 0, blocking: true },
      { name: "PHP tests", exitCode: null, timedOut: true, blocking: true },
      { name: "lint", exitCode: 2, blocking: true },
    ],
  };
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  await expect(
    page.getByText("PHP tests · Fehler hält den Lauf an · Zeitlimit überschritten", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("bootstrap · Fehler hält den Lauf an · Bestanden", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("lint · Fehler hält den Lauf an · Fehlgeschlagen (Exit-Code 2)", {
      exact: true,
    }),
  ).toBeVisible();
});

test("failed native stage offers an explicit override with confirmation", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.nodes[0].status = "failed";
  run.nodes[0].failReason = "session-error";
  run.actions = ["abort", "retry", "reconcile", "override"];
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  await page.getByRole("button", { name: "Übergehen & fortsetzen", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("trotz ihres bisherigen Ergebnisses");
  expect(state.calls.some((call) => call.path.endsWith("/gate"))).toBe(false);
  await page.screenshot({ path: "test-results/pipeline-failed-stage-override.png" });
  await dialog
    .getByRole("button", { name: "Übergehen & fortsetzen", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(state.calls).toContainEqual({
    path: "/pipeline-runs/run-one/gate",
    method: "POST",
    body: { action: "override" },
  });
});

test("the first open stage is selected and the rail shows progress and graph flags", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await pipelinesFixture(page);
  state.runs.push(threeStageRun(state));
  await openPipelines(page, "runs/run-one");
  await expect(page.locator(".run-stage-progress")).toHaveText(
    "1 von 3 Stufen abgeschlossen",
  );
  await expect(page.locator(".run-stage-progress")).toHaveCSS(
    "text-transform",
    "uppercase",
  );
  await expect(stageButtons(page)).toHaveCount(3);
  await expect(stageButtons(page).nth(1)).toHaveAttribute("aria-current", "step");
  await expect(stageButtons(page).nth(0)).not.toHaveAttribute("aria-current", "step");
  await expect(
    stageDetail(page).getByRole("heading", { name: "Prüfer", exact: true }),
  ).toBeVisible();
  await expect(stageButtons(page).nth(1)).toContainText(
    "Claude Code · Wartet auf Freigabe",
  );
  await expect(stageButtons(page).nth(1).locator(".run-stage-flag")).toHaveText([
    "Freigabe",
    "Verifikation",
    "↺ zu Stufe 1",
  ]);
  await expect(stageButtons(page).nth(2).locator(".run-stage-flag")).toHaveText([
    "Pull Request",
  ]);
  await expect(stageButtons(page).nth(0).locator(".run-stage-flag")).toHaveCount(0);
  await expect(stageButtons(page).nth(0).locator(".run-stage-number")).toHaveCSS(
    "border-color",
    "rgb(134, 184, 142)",
  );
  const number = await stageButtons(page)
    .nth(1)
    .locator(".run-stage-number")
    .boundingBox();
  expect(Math.round(number.width)).toBe(26);
  await expect(page.locator(".run-header h2")).toHaveCSS("font-size", "24px");
  await expect(page.locator(".run-header")).toContainText(
    "Entwicklungsablauf · project · gestartet",
  );
  await expect(page.locator(".run-header-status")).toHaveText(
    "Entscheidung erforderlich",
  );
  await expect(stageDetail(page).locator(".run-stage-history")).toContainText(
    "Versuch 1",
  );
  await page.getByText("Ausführungsverlauf (2)", { exact: true }).click();
  await expect(page.locator(".run-execution-log")).toContainText("plan · stage");
  await page.screenshot({ path: "test-results/pipeline-run-detail-desktop.png" });
});

test("the decision block belongs to the current gate stage and the header keeps other actions", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.runs.push(threeStageRun(state));
  await openPipelines(page, "runs/run-one");
  const decision = page.locator(".run-gate-decision");
  await expect(decision).toBeVisible();
  await expect(decision).toHaveCSS("background-color", "rgb(29, 25, 21)");
  await expect(decision).toHaveCSS("border-top-color", "rgb(84, 64, 47)");
  await expect(decision.getByRole("button")).toHaveText([
    "Freigeben",
    "Mit Rückmeldung wiederholen",
    "Zur Reparatur zurückspringen",
    "Übergehen & fortsetzen",
  ]);
  await expect(decision.getByRole("button", { name: "Freigeben" })).toHaveClass(
    /primary/,
  );
  await expect(headerActions(page).getByRole("button")).toHaveText([
    "Aktualisieren",
    "Lauf abbrechen",
    "Ergebnis erneut prüfen",
  ]);
  await expect(headerActions(page).getByLabel("Rückmeldung")).toHaveCount(0);
  await stageButtons(page).nth(0).click();
  await expect(decision).toHaveCount(0);
  await expect(stageDetail(page)).toContainText("Freigegeben");
  await expect(stageDetail(page)).toContainText("Plan ready");
  await expect(page.getByRole("button", { name: "Freigeben", exact: true })).toHaveCount(
    0,
  );
  await stageButtons(page).nth(1).click();
  await decision.getByRole("button", { name: "Freigeben", exact: true }).click();
  await expect
    .poll(() => state.calls.filter((call) => call.path.endsWith("/gate")).at(-1)?.body)
    .toEqual({ action: "accept" });
});

test("a chosen stage survives polling and the confirmation replaces the decision", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const run = threeStageRun(state);
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  await stageButtons(page).nth(2).click();
  await expect(stageButtons(page).nth(2)).toHaveAttribute("aria-current", "step");
  const reads = () =>
    state.calls.filter((call) => call.path === "/pipeline-runs/run-one").length;
  const before = reads();
  run.nodes[1].status = "running";
  run.nodes[1].gateDecision = "feedback";
  run.status = "running";
  run.actions = ["abort"];
  await expect.poll(reads, { timeout: 10000 }).toBeGreaterThan(before);
  await expect(stageButtons(page).nth(1)).toContainText("Arbeitet");
  await expect(stageButtons(page).nth(2)).toHaveAttribute("aria-current", "step");
  await expect(
    stageDetail(page).getByRole("heading", { name: "Veröffentlichung", exact: true }),
  ).toBeVisible();
  await stageButtons(page).nth(1).click();
  await expect(page.locator(".run-gate-decision")).toHaveCount(0);
  await expect(page.locator(".run-gate-confirmation")).toHaveText("Rückmeldung gesendet");
});

test("run detail stays within a 390px viewport and reads in English", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = await pipelinesFixture(page);
  const run = threeStageRun(state);
  run.task = "A very long task headline " + "identifier".repeat(30);
  run.branch = "agentpier/" + "branch-name-".repeat(10);
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  await expect(
    page.getByRole("navigation", { name: "Stages", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".run-stage-progress")).toHaveText("1 of 3 stages completed");
  await expect(page.getByRole("button", { name: "All runs" })).toBeVisible();
  await expect(page.locator(".run-gate-decision").getByRole("button")).toHaveText([
    "Approve",
    "Retry with feedback",
    "Return for repair",
    "Override & Continue",
  ]);
  await expect(
    page.getByRole("navigation", { name: "Stages" }).getByRole("button").nth(1),
  ).toContainText("Approval");
  await expect(page.locator(".run-header")).toContainText("branch agentpier/");
  await expect(page.getByRole("group", { name: "Reported usage" })).toContainText(
    "1,500",
  );
  const rail = await page.locator(".run-stage-rail").boundingBox();
  const content = await stageDetail(page).boundingBox();
  expect(rail.y + rail.height).toBeLessThanOrEqual(content.y);
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({
    path: "test-results/pipeline-run-detail-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "All runs" }).click();
  await expect(page).toHaveURL(/\/pipelines$/);
});

test("back to all runs keeps the list filters of the route", async ({ page }) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  await openPipelines(page, "runs/run-one?status=awaiting-human&project=project-one");
  await page.getByRole("button", { name: "Alle Läufe", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\?project=project-one&status=awaiting-human$/);
});
