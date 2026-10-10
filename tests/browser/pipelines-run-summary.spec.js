import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

test("run header shows the full working directory in monospace", async ({ page }) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.cwd = "/fixture/workspaces/client/project";
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  const cwd = page.locator(".run-header-cwd");
  await expect(cwd).toContainText("Arbeitsverzeichnis");
  await expect(cwd.locator("code")).toHaveText("/fixture/workspaces/client/project");
  const font = await cwd
    .locator("code")
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(font).toMatch(/mono/i);
});

test("reported usage is labelled as the whole run's usage", async ({ page }) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  await openPipelines(page, "runs/run-one");
  const usage = page.getByRole("group", { name: "Gemeldete Nutzung", exact: true });
  await expect(usage).toContainText("1.500");
  await expect(page.locator(".run-usage-block > h4")).toHaveText(
    "Gemeldete Nutzung · gesamter Lauf",
  );
});

test("reported usage stays visible for a run without stages, also in English", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.nodes = [];
  run.status = "failed";
  run.actions = ["delete"];
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  await expect(
    page.getByRole("heading", { name: "Review the application" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Reported usage", exact: true }),
  ).toContainText("1,500");
  await expect(page.locator(".run-usage-block > h4")).toHaveText(
    "Reported usage · whole run",
  );
  await expect(page.locator(".run-header-cwd")).toContainText("Working directory");
});

test("run header shows the run worktree and the folder it was created from", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.workingDir = "/fixture/.agentpier-worktrees/run-one";
  state.runs.push(run);
  await openPipelines(page, "runs/run-one");
  const rows = page.locator(".run-header-cwd");
  await expect(rows.nth(0)).toContainText("Lauf-Worktree");
  await expect(rows.nth(0).locator("code")).toHaveText(
    "/fixture/.agentpier-worktrees/run-one",
  );
  await expect(rows.nth(1)).toContainText("Angelegt aus");
  await expect(rows.nth(1).locator("code")).toHaveText("/fixture/project");
});

for (const [language, reason, kind] of [
  ["de", "Die Sitzung endete mit einem Fehler", "Ergebnis-Erinnerung"],
  ["en", "The session ended with an error", "Result reminder"],
])
  test(`stop reasons and turn kinds are translated (${language})`, async ({ page }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("agentpier-language", value),
      language,
    );
    const state = await pipelinesFixture(page);
    const run = sampleRun(state);
    Object.assign(run.nodes[0], {
      status: "failed",
      verdict: undefined,
      failReason: "session-error",
      overrides: [{ at: "2026-09-07T12:10:00Z", failReason: "turn-timeout" }],
    });
    run.actions = ["retry", "abort"];
    run.executionLog = [
      {
        id: "turn-one",
        nodeId: "stage-one",
        kind: "verdict-nudge",
        startedAt: "2026-09-07T12:00:00Z",
        finishedAt: "2026-09-07T12:05:00Z",
        failReason: "session-error",
      },
    ];
    state.runs.push(run);
    await openPipelines(page, "runs/run-one");
    const stage = page.locator(".run-stage-detail");
    await expect(stage.locator(".run-stage-summary")).toContainText(reason);
    await expect(stage.locator(".run-stage-history")).toContainText(kind);
    await expect(stage.locator(".run-stage-history")).toContainText(reason);
    await expect(stage).toContainText(
      language === "de"
        ? "übergangen: Der Turn hat seine maximale Laufzeit überschritten"
        : "overrode: The turn exceeded its maximum run time",
    );
    await expect(page.locator("main")).not.toContainText("session-error");
    await expect(page.locator("main")).not.toContainText("verdict-nudge");
  });

test("local-only commits ask once more and remove the worktree keeping the branch", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  Object.assign(run, {
    status: "completed",
    actions: ["delete", "create-pr"],
    workspace: { hasRemote: false },
  });
  state.runs.push(run);
  const deletes = [];
  await page.route("**/api/pipeline-runs/run-one**", (route) => {
    const request = route.request();
    if (request.method() !== "DELETE") return route.fallback();
    const url = new URL(request.url());
    deletes.push(url.search);
    if (!url.searchParams.has("confirmLocalCommits"))
      return route.fulfill({
        status: 409,
        json: { code: "PIPELINE_LOCAL_COMMITS", error: "local commits" },
      });
    return route.fallback();
  });
  await openPipelines(page, "runs/run-one");
  await expect(
    page.getByRole("button", { name: "Pull Request erstellen / aktualisieren" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Lauf löschen", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Lauf löschen", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("nur lokal existieren");
  await dialog
    .getByRole("button", { name: "Worktree entfernen, Branch behalten", exact: true })
    .click();
  await expect(page).toHaveURL(/\/pipelines$/);
  expect(deletes).toEqual(["", "?confirmLocalCommits=true"]);
});
