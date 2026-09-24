import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

const runListings = (state) =>
  state.calls.filter((call) => call.method === "GET" && call.path === "/pipeline-runs")
    .length;
const runsTab = (page) =>
  page
    .getByRole("tablist", { name: "Pipelines", exact: true })
    .getByRole("tab", { name: /^Läufe/ });
const allPill = (page) =>
  page
    .getByRole("group", { name: "Status", exact: true })
    .getByRole("button", { name: /^Alle Status/ });

test("the runs tab polls only its list while the counts stay current", async ({
  page,
}) => {
  test.setTimeout(60000);
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  await openPipelines(page, "runs");
  await expect(runsTab(page)).toHaveText(/^Läufe\s*1$/);
  await expect(allPill(page)).toHaveText(/^Alle Status\s*1$/);
  const before = runListings(state);
  await page.waitForTimeout(11000);
  // Two or three list polls; no tab-total poll and no further status pill round.
  expect(runListings(state) - before).toBeLessThanOrEqual(3);
  // A new run changes the list total, which refreshes the pills and the tab once.
  state.runs.push(sampleRun(state, "run-two"));
  await expect(runsTab(page)).toHaveText(/^Läufe\s*2$/, { timeout: 7000 });
  await expect(allPill(page)).toHaveText(/^Alle Status\s*2$/, { timeout: 7000 });
});

test("the project runs tab polls only its list while the pills stay current", async ({
  page,
}) => {
  test.setTimeout(60000);
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
  await page.goto(baseURL + "/projects/project-one?tab=runs");
  await expect(allPill(page)).toHaveText(/^Alle Status\s*1$/);
  const before = runListings(state);
  await page.waitForTimeout(11000);
  expect(runListings(state) - before).toBeLessThanOrEqual(3);
  state.runs.push(sampleRun(state, "run-two"));
  await expect(allPill(page)).toHaveText(/^Alle Status\s*2$/, { timeout: 7000 });
});

const statusPill = (page, label) =>
  page
    .getByRole("group", { name: "Status", exact: true })
    .getByRole("button", { name: new RegExp(`^${label}`) });

test("a listed run changing its status refreshes the pills within one list poll", async ({
  page,
}) => {
  test.setTimeout(30000);
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.status = "running";
  state.runs.push(run);
  await openPipelines(page, "runs");
  await expect(statusPill(page, "Läuft")).toHaveText(/^Läuft\s*1$/);
  await expect(statusPill(page, "Entscheidung erforderlich")).toHaveCount(0);
  run.status = "awaiting-human";
  await expect(statusPill(page, "Entscheidung erforderlich")).toHaveText(
    /^Entscheidung erforderlich\s*1$/,
    { timeout: 7000 },
  );
  await expect(statusPill(page, "Läuft")).toHaveCount(0);
});

test("returning from a run reads the pills once", async ({ page }) => {
  test.setTimeout(30000);
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  const pillReads = [];
  await page.route(
    (url) => url.pathname === "/api/pipeline-runs",
    async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("status") && !url.searchParams.has("page"))
        pillReads.push(url.search);
      await route.fallback();
    },
  );
  await openPipelines(page, "runs");
  await expect(allPill(page)).toHaveText(/^Alle Status\s*1$/);
  await page.getByRole("button", { name: "Lauf öffnen: Review the application" }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/run-one$/);
  state.runs.push(sampleRun(state, "run-two"));
  state.runs[0].status = "failed";
  const before = pillReads.length;
  await page.goBack();
  await expect(allPill(page)).toHaveText(/^Alle Status\s*2$/);
  await page.waitForTimeout(1500);
  // One pill round for the returning list, not a second one for its changed rows.
  expect(pillReads.length - before).toBe(5);
});
