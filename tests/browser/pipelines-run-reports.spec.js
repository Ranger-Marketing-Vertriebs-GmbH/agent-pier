import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

const report = ".pipeline/reports/stage-one/attempt-1/REVIEW.md";

async function openReport(page, { content, changed, files }) {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  await page.route("**/api/pipeline-runs/run-one/nodes/stage-one/artifacts", (route) =>
    route.fulfill({
      json: { artifacts: [{ nodeId: "stage-one", artifacts: [{ path: report }] }] },
    }),
  );
  await page.route("**/api/pipeline-runs/run-one/nodes/stage-one/artifact?*", (route) =>
    route.fulfill({
      json: { content, truncated: false, ...(changed ? { changed: true } : {}) },
    }),
  );
  await openPipelines(page, "runs/run-one");
  const detail = page.locator(".run-stage-detail");
  await detail.getByRole("button", { name: files, exact: true }).click();
  const request = page.waitForRequest((r) => r.url().includes("/artifact?"));
  await detail.getByRole("button", { name: "REVIEW.md", exact: true }).click();
  expect(new URL((await request).url()).searchParams.get("path")).toBe(report);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "REVIEW.md" })).toBeVisible();
  await expect(dialog).toContainText(content);
  return dialog;
}

test("a stage report from the private report area opens by its file name", async ({
  page,
}) => {
  const dialog = await openReport(page, {
    content: "Round two review findings",
    files: "Dateien",
  });
  await expect(dialog.locator(".status-chip")).toHaveCount(0);
});

test("a report rewritten after its stage finished is marked in German", async ({
  page,
}) => {
  const dialog = await openReport(page, {
    content: "Rewritten findings",
    changed: true,
    files: "Dateien",
  });
  await expect(dialog.locator(".status-chip")).toHaveText(
    "Nach Abschluss der Stufe geändert",
  );
});

test("a report rewritten after its stage finished is marked in English", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const dialog = await openReport(page, {
    content: "Rewritten findings",
    changed: true,
    files: "Files",
  });
  await expect(dialog.locator(".status-chip")).toHaveText(
    "Changed after the stage finished",
  );
});
