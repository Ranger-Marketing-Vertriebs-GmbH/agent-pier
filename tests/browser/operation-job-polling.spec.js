import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { recordApiRequests } from "../helpers/visibility.js";
import { operationsFixture } from "./operations-fixture.js";

// An operations job follows the live `job.operation:<id>` topic: its status arrives
// as a frame, and the page stops following it at a terminal status. Without the
// channel it polls the job route until then.

const TOPIC = "job.operation:job-backup";
const backup = (status) => ({
  job: { id: "job-backup", kind: "backup", status, createdAt: "2026-09-07T12:00:00Z" },
});

const jobReads = (requests) =>
  requests
    .list()
    .filter(
      (request) =>
        request.method === "GET" && request.path === "/api/operations/jobs/job-backup",
    );

const jobStatus = (page) =>
  page.getByRole("region", { name: "Vorgang", exact: true }).getByRole("status");

test.describe("live", () => {
  test.use({ live: "manual" });

  test("a backup job's terminal status arrives as a frame", async ({
    page,
    liveStub,
  }) => {
    await operationsFixture(page);
    const requests = recordApiRequests(page);
    await page.goto(baseURL + "/settings/backups?job=job-backup");
    await liveStub.waitForSubscribe(TOPIC);
    liveStub.push(TOPIC, backup("running"));
    await expect(jobStatus(page)).toContainText("Läuft");
    liveStub.push(TOPIC, backup("succeeded"));
    await expect(jobStatus(page)).toContainText("Abgeschlossen");
    // An ended job never changes: the page lets go of its topic.
    await expect
      .poll(() => liveStub.received().some((f) => f.op === "unsub" && f.topic === TOPIC))
      .toBe(true);
    expect(liveStub.subscriptions()).not.toContain(TOPIC);
    expect(jobReads(requests)).toHaveLength(0);
  });
});

test("without the live channel a job is polled until it finishes", async ({
  page,
  liveStub,
}) => {
  const state = await operationsFixture(page);
  state.jobStatus = "running";
  state.jobs["job-backup"] = {
    id: "job-backup",
    kind: "backup",
    createdAt: "2026-09-07T12:00:00Z",
  };
  liveStub.refuse();
  const requests = recordApiRequests(page);
  await page.goto(baseURL + "/settings/backups?job=job-backup");
  await expect(jobStatus(page)).toContainText("Läuft", { timeout: 10000 });
  await expect.poll(() => jobReads(requests).length).toBeGreaterThan(1);
  state.jobStatus = "succeeded";
  await expect(jobStatus(page)).toContainText("Abgeschlossen");
  requests.clear();
  await page.waitForTimeout(5000);
  expect(jobReads(requests)).toHaveLength(0);
});
