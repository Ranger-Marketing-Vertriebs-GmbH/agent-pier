import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";

const english = (page) =>
  page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
const callsTo = (state, suffix, method) =>
  state.calls.filter((c) => c.path.endsWith(suffix) && (!method || c.method === method));

function queuedItems(state) {
  state.queue.items.push(
    {
      id: "item-started",
      projectId: "project-one",
      pipelineId: "pipeline-one",
      pipelineName: "Entwicklungsablauf",
      task: "Build the login page",
      state: "started",
      startedAt: "2026-10-20T10:00:00Z",
      externalRef: "AP-1",
      source: { kind: "mcp" },
      run: { status: "awaiting-human", phase: "executing" },
    },
    {
      id: "item-failed",
      projectId: "project-one",
      pipelineId: "pipeline-one",
      pipelineName: "Entwicklungsablauf",
      task: "Fix the search",
      state: "failed",
      // The engine stores its German message; an English page shows it in English.
      error: "Die Warteschlange ist beendet.",
      source: { kind: "user" },
    },
    {
      id: "item-waiting",
      projectId: "project-one",
      pipelineId: "pipeline-one",
      pipelineName: "Entwicklungsablauf",
      task: "Write the changelog",
      state: "queued",
      baseBranch: "main",
      source: { kind: "user" },
    },
  );
}

test("the queue shows its items with their runs and orders, retries and deletes them", async ({
  page,
}) => {
  await english(page);
  const state = await pipelinesFixture(page);
  queuedItems(state);
  await openPipelines(page, "queue");
  await expect(page).toHaveURL(/\/pipelines\/queue\/project-one$/);
  await expect(page.getByRole("tab", { name: "Queue" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const items = page.locator(".queue-item");
  // Waiting items first, in queue order, then started ones.
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("Fix the search");
  await expect(items.nth(0)).toContainText("Start failed");
  await expect(items.nth(0)).toContainText("The queue is closed.");
  await expect(items.nth(1)).toContainText("Write the changelog");
  await expect(items.nth(1)).toContainText("Waiting");
  await expect(items.nth(1)).toContainText("Base main");
  await expect(items.nth(2)).toContainText("Run: Decision required");
  await expect(items.nth(2)).toContainText("AP-1 · via MCP");
  await expect(
    page.getByRole("button", { name: "Move “Fix the search” up" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Move “Write the changelog” up" }).click();
  await expect(items.nth(0)).toContainText("Write the changelog");
  expect(callsTo(state, "/item-waiting/move")[0].body).toEqual({ direction: "up" });

  await page.getByRole("button", { name: "Start again" }).click();
  await expect(items.nth(1)).toContainText("Waiting");
  expect(callsTo(state, "/item-failed/retry")).toHaveLength(1);

  await page.getByRole("button", { name: "Delete “Fix the search”" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete item “Fix the search”?" });
  await expect(confirm).toContainText("The item will not start, and its task is lost.");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(items).toHaveCount(2);
  expect(callsTo(state, "/item-failed", "DELETE")).toHaveLength(1);

  // A started item opens its run, and leaves the list without touching it.
  await page
    .getByRole("button", { name: "Remove “Build the login page” from the queue" })
    .click();
  await expect(items).toHaveCount(1);
});

test("the owner adds an item and saves the concurrency limit", async ({ page }) => {
  await english(page);
  const state = await pipelinesFixture(page);
  await openPipelines(page, "queue/project-one");
  await expect(
    page.getByText("The queue is empty. Add an item to have it start on its own."),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "Save settings" });
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "More concurrent runs" }).click();
  await page.getByRole("switch", { name: "Count waiting runs" }).check();
  await expect(
    page.getByText(
      "A run waiting for you at a gate, the risk gate or its token budget keeps its slot.",
    ),
  ).toBeVisible();
  await save.click();
  await expect.poll(() => state.queue.settings).toEqual({ limit: 2, countParked: true });

  await page.getByRole("button", { name: "Add to queue" }).click();
  const dialog = page.getByRole("dialog", { name: "Add to queue" });
  await expect(dialog).toContainText("Project: Projekt");
  await expect(dialog.getByLabel("Repository folder")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Entwicklungsablauf" }).check();
  await dialog.getByLabel("Task").fill("Ship the queue");
  await dialog.getByLabel("External reference (optional)").fill("AP-167");
  await dialog.getByLabel("Token budget (optional)").fill("5000");
  await dialog.getByRole("button", { name: "Add to queue" }).click();
  await expect(dialog).toBeHidden();
  expect(callsTo(state, "/project-one/items", "POST")[0].body).toEqual({
    pipelineId: "pipeline-one",
    task: "Ship the queue",
    tokenBudget: 5000,
    externalRef: "AP-167",
  });
  await expect(page.locator(".queue-item")).toContainText("Ship the queue");
});

test("a started item opens its run", async ({ page }) => {
  const state = await pipelinesFixture(page);
  queuedItems(state);
  state.runs.push({
    id: "item-started",
    pipelineId: "pipeline-one",
    pipelineName: "Entwicklungsablauf",
    projectId: "project-one",
    task: "Build the login page",
    status: "running",
    nodes: [],
    actions: ["abort"],
    executionLog: [],
    usage: null,
  });
  await openPipelines(page, "queue/project-one");
  await page.getByRole("button", { name: "Lauf öffnen" }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/item-started$/);
});

test("the queue fits a phone without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  queuedItems(state);
  await openPipelines(page, "queue/project-one");
  await expect(page.locator(".queue-item")).toHaveCount(3);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Alle Projekte" }).click();
  await expect(page).toHaveURL(/\/pipelines\/queue$/);
});
