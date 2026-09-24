import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";
const stageTile = (page, number) =>
  page
    .getByRole("list", { name: "Stufen", exact: true })
    .getByRole("button", { name: new RegExp(`^Stufe ${number}\\b`) });
test("ordered builder saves gates verification singleton PR and bounded backward loops", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "definitions/pipeline-one");
  await stageTile(page, 1).click();
  await expect(page.getByRole("heading", { name: "Stufe 1 bearbeiten" })).toBeVisible();
  await page.getByLabel("Menschliche Freigabe", { exact: true }).check();
  await page.getByLabel("Verifikation ausführen", { exact: true }).check();
  await page.getByLabel("Pull Request erstellen", { exact: true }).check();
  await page.getByRole("button", { name: "Stufe hinzufügen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stufe 2 bearbeiten" })).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Aufgabenprofil", exact: true })
    .getByRole("radio", { name: "Planer", exact: true })
    .check();
  await page.getByLabel("Pull Request erstellen", { exact: true }).check();
  await stageTile(page, 1).click();
  await expect(
    page.getByLabel("Pull Request erstellen", { exact: true }),
  ).not.toBeChecked();
  await stageTile(page, 2).click();
  await page
    .getByRole("radiogroup", { name: "Bei Fehler zurück zu", exact: true })
    .getByRole("radio", { name: "1 · Planer", exact: true })
    .check();
  const rounds = page.getByRole("spinbutton", {
    name: "Maximale Schleifenrunden",
    exact: true,
  });
  await expect(rounds).toHaveAttribute("min", "1");
  await expect(rounds).toHaveAttribute("max", "5");
  await rounds.fill("3");
  await expect(
    page.getByText("↺ Planer springt bei Fehler zu Stufe 1 zurück · max. 3 Runden", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Entwicklungsablauf", exact: true }),
  ).toBeVisible();
  const write = state.calls.find(
    (c) => c.path === "/pipelines/pipeline-one" && c.method === "PATCH",
  );
  expect(write.body.expectedRevision).toBe(1);
  const graph = write.body.graph;
  expect(graph.nodes.filter((n) => n.kind === "createPr")).toHaveLength(1);
  expect(graph.edges).toContainEqual({
    from: "plan",
    to: "plan-verify",
    condition: "default",
  });
  expect(graph.edges).toContainEqual({
    from: "plan-verify",
    to: "plan-gate",
    condition: "default",
  });
  expect(graph.edges.find((e) => e.condition === "fail")).toMatchObject({
    to: "plan",
    maxIterations: 3,
  });
});
test("advanced non-chain graph survives edit save and reload without routing loss", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const graph = {
    entry: "first",
    nodes: [
      { id: "first", kind: "profile", profileId: "profile-one" },
      { id: "second", kind: "profile", profileId: "profile-one" },
    ],
    edges: [{ from: "first", to: "second", condition: "pass" }],
  };
  state.pipelines[0].graph = graph;
  await openPipelines(page, "definitions/pipeline-one");
  await expect(page.getByLabel("Pipelinegraph", { exact: true })).toHaveValue(
    JSON.stringify(graph, null, 2),
  );
  await page.getByRole("button", { name: "Stufenansicht", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("erweiterte Verbindungen");
  await page
    .getByRole("textbox", { name: "Pipelinename", exact: true })
    .fill("Erweiterte Pipeline");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  expect(state.calls.find((c) => c.method === "PATCH").body.graph).toEqual(graph);
  await page
    .getByRole("button", { name: "Bearbeiten: Erweiterte Pipeline", exact: true })
    .click();
  await page.reload();
  await expect(page.getByLabel("Pipelinegraph", { exact: true })).toHaveValue(
    JSON.stringify(graph, null, 2),
  );
});
test("mobile verification edits timeout blocking order and deletion while preserving failed drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  await openPipelines(page, "verification/project-one");
  await page.getByRole("button", { name: "Prüfschritt hinzufügen", exact: true }).click();
  await page.getByLabel("Prüfschritt 1: Name", { exact: true }).fill("Tests");
  await page.getByLabel("Prüfschritt 1: Befehl", { exact: true }).fill("npm test");
  await page
    .getByLabel("Prüfschritt 1: Zeitlimit in Sekunden", { exact: true })
    .fill("120");
  await page.getByLabel("Fehler hält den Lauf an", { exact: true }).uncheck();
  state.fail = "/pipeline-verification/project-one";
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(page.getByLabel("Prüfschritt 1: Befehl", { exact: true })).toHaveValue(
    "npm test",
  );
  state.fail = "";
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByLabel("Prüfschritt 1: Befehl", { exact: true })).toHaveValue(
    "npm test",
  );
  expect(state.steps).toEqual([
    { name: "Tests", command: "npm test", timeoutMs: 120000, blocking: false },
  ]);
  await page
    .getByRole("button", { name: "Prüfschritt entfernen 1", exact: true })
    .click();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByText("Keine Verifikation konfiguriert.", { exact: true }),
  ).toBeVisible();
  expect(state.steps).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("editing a linear definition retains existing side-effect node identities", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const graph = {
    entry: "plan",
    nodes: [
      { id: "plan", kind: "profile", profileId: "profile-one" },
      { id: "existing-check", kind: "verify" },
      { id: "existing-approval", kind: "gate" },
    ],
    edges: [
      { from: "plan", to: "existing-check", condition: "default" },
      { from: "existing-check", to: "existing-approval", condition: "default" },
    ],
  };
  state.pipelines[0].graph = graph;
  await openPipelines(page, "definitions/pipeline-one");
  await page.getByRole("textbox", { name: "Pipelinename", exact: true }).fill("Renamed");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Renamed", exact: true }),
  ).toBeVisible();
  expect(state.calls.find((c) => c.method === "PATCH").body.graph).toEqual(graph);
});

const twoStageGraph = {
  entry: "plan",
  nodes: [
    { id: "plan", kind: "profile", profileId: "profile-one" },
    { id: "build", kind: "profile", profileId: "profile-gone" },
  ],
  edges: [
    { from: "plan", to: "build", condition: "default" },
    { from: "build", to: "plan", condition: "fail", maxIterations: 2 },
  ],
};

test("desktop definitions select the first pipeline and highlight the chosen stage", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.pipelines[0].graph = twoStageGraph;
  state.pipelines.push({
    ...state.pipelines[0],
    id: "pipeline-two",
    name: "Wartung",
    description: "",
    graph: {
      entry: "fix",
      nodes: [{ id: "fix", kind: "profile", profileId: "profile-one" }],
      edges: [],
    },
  });
  await openPipelines(page, "definitions");
  await expect(page).toHaveURL(/\/pipelines\/definitions\/pipeline-one$/);
  const first = page.getByRole("button", {
    name: "Bearbeiten: Entwicklungsablauf",
    exact: true,
  });
  await expect(first).toHaveAttribute("aria-current", "true");
  await expect(first).toContainText("2 Stufen");
  await expect(
    page.getByRole("textbox", { name: "Pipelinename", exact: true }),
  ).toHaveValue("Entwicklungsablauf");
  await expect(stageTile(page, 1)).toHaveAttribute("aria-pressed", "true");
  await stageTile(page, 2).click();
  await expect(stageTile(page, 2)).toHaveAttribute("aria-pressed", "true");
  await expect(stageTile(page, 1)).toHaveAttribute("aria-pressed", "false");
  await expect(stageTile(page, 2)).toHaveCSS("border-top-color", "rgb(244, 154, 88)");
  await expect(stageTile(page, 2)).toHaveCSS("background-color", "rgb(29, 25, 21)");
  await expect(stageTile(page, 2)).toContainText("↺ zu Stufe 1");
  await expect(page.getByRole("heading", { name: "Stufe 2 bearbeiten" })).toBeVisible();
  // A saved profile that is no longer eligible stays visible and selected.
  await expect(
    page
      .getByRole("radiogroup", { name: "Aufgabenprofil", exact: true })
      .getByRole("radio", { name: "profile-gone", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByText(
      "↺ profile-gone springt bei Fehler zu Stufe 1 zurück · max. 2 Runden",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  const rounds = page.getByRole("spinbutton", {
    name: "Maximale Schleifenrunden",
    exact: true,
  });
  const more = page.getByRole("button", { name: "Schleifenrunden erhöhen", exact: true });
  for (let i = 0; i < 3; i++) await more.click();
  await expect(rounds).toHaveValue("5");
  await expect(more).toBeDisabled();
  await rounds.focus();
  await page.keyboard.press("ArrowDown");
  await expect(rounds).toHaveValue("4");
  await page.getByRole("button", { name: "Nach vorn 2", exact: true }).click();
  await expect(stageTile(page, 1)).toContainText("profile-gone");
  await expect(stageTile(page, 1)).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Nach vorn 1", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Stufe entfernen 1", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Stufen" }).getByRole("button"),
  ).toHaveCount(2);
  // Unsaved edits are not silently discarded when another pipeline is chosen.
  await page.getByRole("button", { name: "Bearbeiten: Wartung", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Aktion bestätigen" });
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(page).toHaveURL(/\/definitions\/pipeline-one$/);
  await expect(
    page.getByRole("list", { name: "Stufen" }).getByRole("button"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Bearbeiten: Wartung", exact: true }).click();
  await confirm.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(page).toHaveURL(/\/definitions\/pipeline-two$/);
  await expect(
    page.getByRole("textbox", { name: "Pipelinename", exact: true }),
  ).toHaveValue("Wartung");
});

test("unknown definitions report unavailability and new pipelines start empty", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "definitions/missing-pipeline");
  await expect(
    page.getByText("Diese Pipeline ist nicht verfügbar.", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/definitions\/missing-pipeline$/);
  await page.getByRole("button", { name: "Neue Pipeline", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/definitions\/new$/);
  await expect(
    page.getByRole("textbox", { name: "Pipelinename", exact: true }),
  ).toHaveValue("");
  await page.getByRole("textbox", { name: "Pipelinename", exact: true }).fill("Neu");
  await page.getByRole("button", { name: "Stufe hinzufügen", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Aufgabenprofil", exact: true })
    .getByRole("radio", { name: "Planer", exact: true })
    .check();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/definitions\/pipeline-new$/);
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Neu", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  expect(state.calls.find((c) => c.method === "POST").body.graph.nodes).toHaveLength(1);
  state.fail = "/pipelines/pipeline-one";
  await page
    .getByRole("button", { name: "Löschen: Entwicklungsablauf", exact: true })
    .click();
  const confirm = page.getByRole("dialog", { name: "Aktion bestätigen" });
  await confirm.getByRole("button", { name: "Entfernen", exact: true }).click();
  await expect(confirm.getByRole("alert")).toContainText("Fixture conflict");
});

test("mobile definitions show the list first and the editor without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  state.pipelines[0].graph = twoStageGraph;
  await openPipelines(page, "definitions");
  const item = page.getByRole("button", {
    name: "Bearbeiten: Entwicklungsablauf",
    exact: true,
  });
  await expect(item).toBeVisible();
  await expect(page).toHaveURL(/\/pipelines\/definitions$/);
  await item.click();
  await expect(page).toHaveURL(/\/definitions\/pipeline-one$/);
  await expect(item).toBeHidden();
  await stageTile(page, 2).click();
  await expect(
    page.getByRole("spinbutton", { name: "Maximale Schleifenrunden", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Alle Pipelines", exact: true }).click();
  await expect(item).toBeVisible();
});

test.describe("English pipeline definitions", () => {
  test.use({ locale: "en-GB" });
  test("stage flow and editor use English copy", async ({ page }) => {
    const state = await pipelinesFixture(page);
    state.pipelines[0].graph = twoStageGraph;
    await openPipelines(page, "definitions/pipeline-one");
    const stages = page.getByRole("list", { name: "Stages", exact: true });
    await stages.getByRole("button", { name: /^Stage 2\b/ }).click();
    await expect(page.getByRole("heading", { name: "Edit stage 2" })).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "On failure, return to", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("↺ profile-gone returns to stage 1 on failure · max. 2 rounds", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Move forward 2" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit: Entwicklungsablauf", exact: true }),
    ).toContainText("2 stages");
    await expect(page.getByRole("button", { name: "Add stage" })).toBeVisible();
  });
});
