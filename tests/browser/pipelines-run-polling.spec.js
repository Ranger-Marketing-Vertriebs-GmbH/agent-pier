import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { recordApiRequests } from "../helpers/visibility.js";
import { runCountsAnswer } from "../helpers/run-counts.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

// The run lists follow the live channel: page 1 and the status counts are pushed
// (`pipeline.runs:<project|*>:<status|*>`, `pipeline.counts[:<project>]`), a later
// page reads its route once per `changed` of `pipeline.runs.changed[:<project>]`.
// An idle visible tab reads no run list and no counts.
test.use({ live: "manual" });

const runReads = (requests) =>
  requests
    .list()
    .filter(
      ({ method, path }) =>
        method === "GET" &&
        (path === "/api/pipeline-runs" || path === "/api/pipeline-run-counts"),
    );
const runsTab = (page) =>
  page
    .getByRole("tablist", { name: "Pipelines", exact: true })
    .getByRole("tab", { name: /^Läufe/ });
const statusPill = (page, label) =>
  page
    .getByRole("group", { name: "Status", exact: true })
    .getByRole("button", { name: new RegExp(`^${label}`) });
const allPill = (page) => statusPill(page, "Alle Status");

// Page 1 as GET /api/pipeline-runs answers it.
const firstPage = (runs, projectId) => {
  const listed = runs.filter((run) => !projectId || run.projectId === projectId);
  return { runs: listed.slice(0, 20), total: listed.length, page: 1, pageSize: 20 };
};

async function pushState(page, liveStub) {
  await liveStub.waitForSubscribe("state");
  liveStub.push(
    "state",
    await page.evaluate(() => fetch("/api/state").then((r) => r.json())),
  );
}

// Pushes page 1 and the counts of `projectId` (all runs without one).
async function pushRuns(liveStub, runs, projectId) {
  const list = `pipeline.runs:${projectId || "*"}:*`;
  const counts = projectId ? `pipeline.counts:${projectId}` : "pipeline.counts";
  await liveStub.waitForSubscribe(list);
  await liveStub.waitForSubscribe(counts);
  liveStub.push(list, firstPage(runs, projectId));
  liveStub.push(counts, runCountsAnswer(runs, projectId));
}

test("the idle runs tab reads no run list or counts; pushes update it", async ({
  page,
  liveStub,
}) => {
  test.setTimeout(30000);
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  const requests = recordApiRequests(page);
  await openPipelines(page, "runs");
  await pushState(page, liveStub);
  await pushRuns(liveStub, state.runs);
  await expect(runsTab(page)).toHaveText(/^Läufe\s*1$/);
  await expect(allPill(page)).toHaveText(/^Alle Status\s*1$/);
  requests.clear();
  await page.waitForTimeout(6000);
  expect(runReads(requests)).toEqual([]);
  // A new run is pushed: the table, the pills and the tab follow without a read.
  state.runs.push(sampleRun(state, "run-two"));
  await pushRuns(liveStub, state.runs);
  await expect(runsTab(page)).toHaveText(/^Läufe\s*2$/);
  await expect(allPill(page)).toHaveText(/^Alle Status\s*2$/);
  expect(runReads(requests)).toEqual([]);
});

test("the idle project runs tab reads no run list or counts", async ({
  page,
  liveStub,
}) => {
  test.setTimeout(30000);
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    if (path === "/repositories")
      return route.fulfill({ json: { credentials: [], projects: [] } });
    if (path === "/agentbus")
      return route.fulfill({ json: { version: "", note: "", projects: [] } });
    return route.fallback();
  });
  const requests = recordApiRequests(page);
  await page.goto(baseURL + "/projects/project-one?tab=runs");
  await pushState(page, liveStub);
  await pushRuns(liveStub, state.runs, "project-one");
  await expect(allPill(page)).toHaveText(/^Alle Status\s*1$/);
  requests.clear();
  await page.waitForTimeout(6000);
  expect(runReads(requests)).toEqual([]);
  state.runs.push(sampleRun(state, "run-two"));
  await pushRuns(liveStub, state.runs, "project-one");
  await expect(allPill(page)).toHaveText(/^Alle Status\s*2$/);
  expect(runReads(requests)).toEqual([]);
});

test("pushed counts move a run's status between the pills", async ({
  page,
  liveStub,
}) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.status = "running";
  state.runs.push(run);
  await openPipelines(page, "runs");
  await pushState(page, liveStub);
  await pushRuns(liveStub, state.runs);
  await expect(statusPill(page, "Läuft")).toHaveText(/^Läuft\s*1$/);
  await expect(statusPill(page, "Entscheidung erforderlich")).toHaveCount(0);
  run.status = "awaiting-human";
  await pushRuns(liveStub, state.runs);
  await expect(statusPill(page, "Entscheidung erforderlich")).toHaveText(
    /^Entscheidung erforderlich\s*1$/,
  );
  await expect(statusPill(page, "Läuft")).toHaveCount(0);
});

test("returning from a run reads no pills: the counts come back pushed", async ({
  page,
  liveStub,
}) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  const requests = recordApiRequests(page);
  await openPipelines(page, "runs");
  await pushState(page, liveStub);
  await pushRuns(liveStub, state.runs);
  await expect(allPill(page)).toHaveText(/^Alle Status\s*1$/);
  await page.getByRole("button", { name: "Lauf öffnen: Review the application" }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/run-one$/);
  requests.clear();
  await page.goBack();
  await expect(allPill(page)).toHaveText(/^Alle Status\s*1$/);
  await page.waitForTimeout(1500);
  expect(runReads(requests).filter(({ path }) => path.endsWith("-counts"))).toEqual([]);
});

test("a later page reads its route once, then once per changed", async ({
  page,
  liveStub,
}) => {
  test.setTimeout(30000);
  const state = await pipelinesFixture(page);
  for (let index = 0; index < 22; index += 1)
    state.runs.push({ ...sampleRun(state, `run-${index}`), task: `Task ${index}` });
  const listings = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/pipeline-runs" && url.searchParams.get("page") === "2")
      listings.push(url.search);
  });
  await openPipelines(page, "runs?page=2");
  await pushState(page, liveStub);
  await liveStub.waitForSubscribe("pipeline.runs.changed");
  await liveStub.waitForSubscribe("pipeline.counts");
  liveStub.push("pipeline.counts", runCountsAnswer(state.runs));
  expect(liveStub.subscriptions()).not.toContain("pipeline.runs:*:*");
  await expect(page.getByText("Task 21")).toBeVisible();
  expect(listings).toHaveLength(1);
  await page.waitForTimeout(6000);
  expect(listings).toHaveLength(1);
  state.runs.push({ ...sampleRun(state, "run-late"), task: "Task late" });
  liveStub.changed("pipeline.runs.changed");
  await expect.poll(() => listings.length).toBe(2);
  await page.waitForTimeout(1000);
  expect(listings).toHaveLength(2);
});
