import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";
const runRows = (page) =>
  page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /^Lauf öffnen:/ }) });
const statusFilter = (page) => page.getByRole("group", { name: "Status", exact: true });
const statusPill = (page, label) =>
  statusFilter(page).getByRole("button", { name: new RegExp(`^${label}`) });
const startDialog = (page) => page.getByRole("dialog", { name: "Lauf starten" });
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
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
  const stage = page.locator(".pipeline-timeline article").filter({
    hasText: "Missing validation",
  });
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
  await expect(statusFilter(page).getByRole("button")).toHaveText([
    /^Alle Status\s*21$/,
    /^Fehlgeschlagen\s*1$/,
    /^Abgeschlossen\s*20$/,
  ]);
  await page.getByRole("button", { name: "Läufe: Nächste Seite", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(
    page.getByRole("button", { name: "Lauf öffnen: Task 20", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Lauf öffnen: Task 20", exact: true }),
  ).toBeVisible();
  await statusPill(page, "Fehlgeschlagen").click();
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
  await expect(statusPill(page, "Fehlgeschlagen")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(statusFilter(page).getByRole("button")).toHaveText([
    /^Alle Status\s*20$/,
    /^Fehlgeschlagen\s*0$/,
    /^Abgeschlossen\s*20$/,
  ]);
});
test("mobile run creation suppresses duplicate submissions and opens the persisted run", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  await openPipelines(page, "runs/new");
  const dialog = startDialog(page);
  await dialog
    .getByRole("radiogroup", { name: "Pipelinename", exact: true })
    .getByRole("radio", { name: "Entwicklungsablauf", exact: true })
    .check();
  await dialog.getByLabel("Arbeitsverzeichnis", { exact: true }).fill("/fixture/project");
  await dialog
    .getByLabel("Aufgabe", { exact: true })
    .fill("A long task " + "details ".repeat(60) + "identifier".repeat(40));
  await page.screenshot({ path: "test-results/pipeline-start-run-sheet.png" });
  const sheet = await dialog.boundingBox();
  expect(Math.round(sheet.width)).toBe(390);
  state.hold = "/pipeline-runs";
  await dialog.getByRole("button", { name: "Lauf starten", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Lauf starten", exact: true }),
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
  const dialog = startDialog(page);
  await dialog.getByRole("radio", { name: "Entwicklungsablauf", exact: true }).check();
  await dialog.getByText("Projekt hinzufügen", { exact: true }).first().click();
  await dialog
    .getByLabel("Projektordner registrieren", { exact: true })
    .fill("/fixture/registered");
  await dialog.getByRole("button", { name: "Projekt hinzufügen", exact: true }).click();
  await expect(dialog.getByLabel("Arbeitsverzeichnis", { exact: true })).toHaveValue(
    "/fixture/registered",
  );
  await expect(
    dialog
      .getByRole("radiogroup", { name: "Projekt", exact: true })
      .getByRole("radio", { name: "Registered /fixture/registered", exact: true }),
  ).toBeChecked();
  await dialog.getByLabel("Aufgabe", { exact: true }).fill("Build registered project");
  await dialog.getByRole("button", { name: "Lauf starten", exact: true }).click();
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
    page.getByRole("heading", { name: "Entwicklungsablauf", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pipeline-prose")).toBeHidden();
  const sidebar = await page.locator(".pipeline-run-sidebar").boundingBox();
  const content = await page.locator(".pipeline-run-content").boundingBox();
  expect(sidebar.x + sidebar.width).toBeLessThan(content.x);
  await page.getByText("Konfigurierte Prüfschritte (2)", { exact: true }).click();
  await expect(verification.getByText("JavaScript tests", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/pipeline-verification-desktop.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.locator(".pipeline-task > summary").click();
  await expect(
    page.getByRole("heading", { name: "Implementation", exact: true }),
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
  await expect(page.locator(".pipeline-status-badge")).toHaveText("Abgeschlossen");
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

for (const width of [1440, 390]) {
  test(`run table bounds kickoff text and filters statuses at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await pipelinesFixture(page);
    const kickoff =
      "NEONNIGHTS-358 — verwaiste CSS-Regeln entfernen. " +
      "Ausführliche Arbeitsanweisung mit Prüfungen und Kontext. ".repeat(80);
    for (const [id, status] of [
      ["active", "running"],
      ["blocked", "awaiting-human"],
      ["done", "completed"],
    ]) {
      const run = sampleRun(state, id);
      run.status = status;
      run.nodes[0].status =
        status === "completed"
          ? "passed"
          : status === "running"
            ? "running"
            : "awaiting-gate";
      run.task = id === "active" ? kickoff : `NEONNIGHTS-${id}: Weitere Aufgabe`;
      run.createdAt = "2026-09-10T05:00:00Z";
      if (id === "active") run.verifyJob = { id: "verify", startedAt: run.createdAt };
      state.runs.push(run);
    }
    await openPipelines(page, "runs");
    await expect(
      page.getByRole("tablist", { name: "Pipelines", exact: true }).getByRole("tab"),
    ).toHaveText([
      /^Läufe\s*3$/,
      /^Definitionen\s*1$/,
      /^Aufgabenprofile\s*1$/,
      "Verifikation",
    ]);
    const rows = runRows(page);
    await expect(rows).toHaveCount(3);
    await expect(statusFilter(page).getByRole("button")).toHaveText([
      /^Alle Status\s*3$/,
      /^Entscheidung erforderlich\s*1$/,
      /^Läuft\s*1$/,
      /^Abgeschlossen\s*1$/,
    ]);
    const pill = await statusPill(page, "Alle Status").boundingBox();
    expect(Math.round(pill.height)).toBe(32);
    expect(
      (await rows.first().locator(".run-table-title").innerText()).length,
    ).toBeLessThanOrEqual(160);
    expect(
      await rows.first().evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThan(width > 700 ? 110 : 260);
    await expect(rows.first()).toContainText("Verifikation läuft");
    await expect(rows.first()).toContainText("Aktuelle Stufe: Planer");
    await expect(rows.first()).toContainText("0 von 1 Stufen abgeschlossen");
    await expect(rows.first().getByTitle("/fixture/project")).toHaveText("project");
    await expect(rows.first().getByText(/^Gestartet: /)).toBeVisible();
    const projectCell = await rows.first().getByTitle("/fixture/project").boundingBox();
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest("[title]")?.title,
        [projectCell.x + projectCell.width / 2, projectCell.y + projectCell.height / 2],
      ),
    ).toBe("/fixture/project");
    await expect(rows.nth(1)).toHaveCSS("background-color", "rgb(29, 25, 21)");
    await expect(rows.nth(0)).not.toHaveCSS("background-color", "rgb(29, 25, 21)");
    const headers = page.getByRole("columnheader");
    if (width > 700) {
      await expect(headers).toHaveText([
        "Aufgabe",
        "Projekt",
        "Fortschritt",
        "Status",
        "Aktualisiert",
      ]);
      const task = await rows.first().getByRole("cell").nth(0).boundingBox();
      const updated = await rows.first().getByRole("cell").nth(4).boundingBox();
      expect(Math.abs(task.y - updated.y)).toBeLessThan(20);
      expect(Math.round(updated.width)).toBe(96);
    } else await expect(headers.first()).toBeHidden();
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({
      path: `test-results/pipeline-run-overview-${width}.png`,
      fullPage: true,
    });
    await statusPill(page, "Abgeschlossen").click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("NEONNIGHTS-done");
    await expect(page).toHaveURL(/status=completed/);
    await page.reload();
    await expect(statusPill(page, "Abgeschlossen")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(rows).toHaveCount(1);
    await statusPill(page, "Alle Status").click();
    await expect(rows).toHaveCount(3);
    await rows
      .first()
      .getByRole("button", { name: /^Lauf öffnen:/ })
      .click();
    await expect(page).toHaveURL(/runs\/active/);
    await page.locator(".pipeline-task summary").click();
    await expect(page.getByText(kickoff, { exact: true })).toBeVisible();
  });
}

test("the start-run dialog opens over the list, preselects a definition and closes back", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.projects.push({ id: "project-two", name: "Projekt", cwd: "/fixture/worktree" });
  await openPipelines(page, "runs");
  await page.getByRole("button", { name: "Lauf starten", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/new$/);
  const dialog = startDialog(page);
  const projectRadios = dialog
    .getByRole("radiogroup", { name: "Projekt", exact: true })
    .getByRole("radio");
  await expect(projectRadios).toHaveCount(2);
  await expect(
    dialog.getByRole("radio", { name: "Projekt /fixture/project", exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByLabel("Ausgangsbranch (optional)", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("radio", { name: "Projekt /fixture/worktree", exact: true })
    .check();
  await expect(dialog.getByLabel("Arbeitsverzeichnis", { exact: true })).toHaveValue(
    "/fixture/worktree",
  );
  await dialog
    .getByRole("radio", { name: "Projekt /fixture/project", exact: true })
    .check();
  await page.screenshot({ path: "test-results/pipeline-start-run-dialog.png" });
  await expect(dialog.getByLabel("Arbeitsverzeichnis", { exact: true })).toHaveValue(
    "/fixture/project",
  );
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/pipelines$/);
  await page.getByRole("tab", { name: /^Definitionen/ }).click();
  await page.getByRole("button", { name: "Lauf starten", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/new$/);
  await expect(
    dialog.getByRole("radio", { name: "Entwicklungsablauf", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/pipelines$/);
});

test("many pipelines fall back to the select with the same accessible name", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.pipelines = Array.from({ length: 7 }, (_, index) => ({
    ...state.pipelines[0],
    id: `pipeline-${index}`,
    name: `Pipeline ${index}`,
  }));
  await openPipelines(page, "runs/new");
  const dialog = startDialog(page);
  await expect(dialog.getByLabel("Aufgabe", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radiogroup", { name: "Pipelinename" })).toHaveCount(0);
  await dialog.getByLabel("Pipelinename", { exact: true }).selectOption("pipeline-6");
  await dialog.getByLabel("Aufgabe", { exact: true }).fill("Use the last pipeline");
  await dialog.getByRole("button", { name: "Lauf starten", exact: true }).click();
  await expect(page).toHaveURL(/runs\/new-run$/);
  expect(
    state.calls.find((c) => c.path === "/pipeline-runs" && c.method === "POST").body,
  ).toEqual({ pipelineId: "pipeline-6", cwd: "/fixture", task: "Use the last pipeline" });
});
