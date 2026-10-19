import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

test("a stage report from the private report area opens by its file name", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  const report = ".pipeline/reports/stage-one/attempt-1/REVIEW.md";
  await page.route("**/api/pipeline-runs/run-one/nodes/stage-one/artifacts", (route) =>
    route.fulfill({
      json: { artifacts: [{ nodeId: "stage-one", artifacts: [{ path: report }] }] },
    }),
  );
  await page.route("**/api/pipeline-runs/run-one/nodes/stage-one/artifact?*", (route) =>
    route.fulfill({ json: { content: "Round two review findings", truncated: false } }),
  );
  await openPipelines(page, "runs/run-one");
  const detail = page.locator(".run-stage-detail");
  await detail.getByRole("button", { name: "Dateien", exact: true }).click();
  const request = page.waitForRequest((r) => r.url().includes("/artifact?"));
  await detail.getByRole("button", { name: "REVIEW.md", exact: true }).click();
  expect(new URL((await request).url()).searchParams.get("path")).toBe(report);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "REVIEW.md" })).toBeVisible();
  await expect(dialog).toContainText("Round two review findings");
});
