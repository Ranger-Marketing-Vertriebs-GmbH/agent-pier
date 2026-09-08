import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";
test("ordered builder saves gates verification singleton PR and bounded backward loops", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "definitions/pipeline-one");
  await page.getByLabel("Menschliche Freigabe", { exact: true }).check();
  await page.getByLabel("Verifikation ausführen", { exact: true }).check();
  await page.getByLabel("Pull Request erstellen", { exact: true }).check();
  await page.getByRole("button", { name: "Stufe hinzufügen", exact: true }).click();
  await page
    .getByLabel("Aufgabenprofil", { exact: true })
    .nth(1)
    .selectOption("profile-one");
  await page.getByLabel("Pull Request erstellen", { exact: true }).nth(1).check();
  await expect(
    page.getByLabel("Pull Request erstellen", { exact: true }).first(),
  ).not.toBeChecked();
  await page.getByLabel("Bei Fehler zurück zu", { exact: true }).selectOption("plan");
  await page.getByLabel("Maximale Schleifenrunden", { exact: true }).fill("3");
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
