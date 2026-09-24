import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";
const runRows = (page) =>
  page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /^Lauf öffnen:/ }) });
const statusFilter = (page) => page.getByRole("group", { name: "Status", exact: true });
const statusPill = (page, label) =>
  statusFilter(page).getByRole("button", { name: new RegExp(`^${label}`) });
const startDialog = (page) => page.getByRole("dialog", { name: "Lauf starten" });
const clickCentre = async (page, locator) => {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
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

test("clicks on the project text and the progress cell open the run", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  await openPipelines(page, "runs");
  const row = runRows(page).first();
  await clickCentre(page, row.getByTitle("/fixture/project"));
  await expect(page).toHaveURL(/runs\/run-one$/);
  await page.goBack();
  await clickCentre(page, runRows(page).first().locator(".run-table-progress"));
  await expect(page).toHaveURL(/runs\/run-one$/);
});
