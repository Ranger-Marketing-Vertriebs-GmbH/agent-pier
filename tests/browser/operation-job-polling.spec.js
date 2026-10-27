import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { recordApiRequests } from "../helpers/visibility.js";
import { operationsFixture } from "./operations-fixture.js";

const jobReads = (requests) =>
  requests
    .list()
    .filter(
      (request) =>
        request.method === "GET" && request.path === "/api/operations/jobs/job-backup",
    );

test("a finished operation job stops polling", async ({ page }) => {
  const state = await operationsFixture(page);
  state.jobStatus = "running";
  state.jobs["job-backup"] = {
    id: "job-backup",
    kind: "backup",
    createdAt: "2026-09-07T12:00:00Z",
  };
  const requests = recordApiRequests(page);
  await page.goto(baseURL + "/settings/backups?job=job-backup");
  const status = page
    .getByRole("region", { name: "Vorgang", exact: true })
    .getByRole("status");
  await expect(status).toContainText("Läuft");
  await expect.poll(() => jobReads(requests).length).toBeGreaterThan(1);
  state.jobStatus = "succeeded";
  await expect(status).toContainText("Abgeschlossen");
  requests.clear();
  await page.waitForTimeout(5000);
  expect(jobReads(requests)).toHaveLength(0);
});
