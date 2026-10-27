import { test, expect } from "@playwright/test";
import { recordApiRequests, setTabHidden } from "../helpers/visibility.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

test("a hidden run detail sends no API request and resumes when visible", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  const requests = recordApiRequests(page);
  await openPipelines(page, "runs/run-one");
  await expect(page.getByText("Review the application").first()).toBeVisible();
  await setTabHidden(page, true);
  requests.clear();
  await page.waitForTimeout(6000);
  expect(requests.list()).toEqual([]);
  await setTabHidden(page, false);
  await expect.poll(() => requests.list().length, { timeout: 1000 }).toBeGreaterThan(0);
});
