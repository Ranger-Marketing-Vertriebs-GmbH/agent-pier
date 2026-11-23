import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { pipelinesFixture, sampleRun } from "./pipelines-fixture.js";

// The run detail and the queue follow the live `pipeline.run` and `pipeline.queue`
// topics: what the channel pushes shows without a REST read of the same route.
test.use({ live: "manual" });

const reads = (state, path) =>
  state.calls.filter((call) => call.method === "GET" && call.path === path);

async function pushState(page, liveStub) {
  await liveStub.waitForSubscribe("state");
  liveStub.push(
    "state",
    await page.evaluate(() => fetch("/api/state").then((r) => r.json())),
  );
}

test("a pushed run status updates the run header without GET /api/pipeline-runs/<id>", async ({
  page,
  liveStub,
}) => {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  state.runs.push(run);
  await page.goto(baseURL + "/pipelines/runs/run-one");
  await pushState(page, liveStub);
  await liveStub.waitForSubscribe("pipeline.run:run-one");
  liveStub.push("pipeline.run:run-one", { run: structuredClone(run) });
  const status = page.locator(".run-header-status");
  await expect(status).toHaveText("Entscheidung erforderlich");
  liveStub.push("pipeline.run:run-one", {
    run: { ...structuredClone(run), status: "running", actions: ["abort"] },
  });
  await expect(status).toHaveText("Läuft");
  expect(reads(state, "/pipeline-runs/run-one")).toEqual([]);
});

for (const [language, unavailable] of [
  ["de", "Dieser Lauf ist nicht verfügbar."],
  ["en", "This run is unavailable."],
])
  test(`a run pushed as missing shows that it is unavailable (${language})`, async ({
    page,
    liveStub,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("agentpier-language", value),
      language,
    );
    const state = await pipelinesFixture(page);
    await page.goto(baseURL + "/pipelines/runs/run-gone");
    await pushState(page, liveStub);
    await liveStub.waitForSubscribe("pipeline.run:run-gone");
    liveStub.push("pipeline.run:run-gone", { run: null });
    await expect(page.getByRole("alert")).toHaveText(unavailable);
    expect(reads(state, "/pipeline-runs/run-gone")).toEqual([]);
  });

test("a pushed queue item shows without GET /api/pipeline-queue/<project>", async ({
  page,
  liveStub,
}) => {
  const state = await pipelinesFixture(page);
  await page.goto(baseURL + "/pipelines/queue/project-one");
  await pushState(page, liveStub);
  const topic = "pipeline.queue:project-one";
  await liveStub.waitForSubscribe(topic);
  const view = { projectId: "project-one", settings: state.queue.settings, items: [] };
  liveStub.push(topic, view);
  await expect(page.getByText("Pushed queue task")).toHaveCount(0);
  liveStub.push(topic, {
    ...view,
    items: [
      {
        id: "item-pushed",
        projectId: "project-one",
        pipelineId: "pipeline-one",
        pipelineName: "Entwicklungsablauf",
        task: "Pushed queue task",
        state: "queued",
        error: null,
        source: { kind: "user" },
        createdAt: "2026-10-27T10:00:00.000Z",
        startedAt: null,
      },
    ],
  });
  await expect(page.getByText("Pushed queue task")).toBeVisible();
  expect(reads(state, "/pipeline-queue/project-one")).toEqual([]);
});

test("a status-filtered first page and its pill follow the pushed list and counts", async ({
  page,
  liveStub,
}) => {
  const state = await pipelinesFixture(page);
  // The app's own reads of the filtered list or the counts (the stub reads nothing).
  const listings = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/pipeline-run-counts" ||
      (url.pathname === "/api/pipeline-runs" && url.searchParams.has("status"))
    )
      listings.push(url.pathname + url.search);
  });
  await page.goto(baseURL + "/pipelines/runs?status=failed");
  await pushState(page, liveStub);
  const list = "pipeline.runs:*:failed";
  await liveStub.waitForSubscribe(list);
  await liveStub.waitForSubscribe("pipeline.counts");
  const failed = { ...sampleRun(state), status: "failed", task: "Pushed failed run" };
  liveStub.push(list, { runs: [failed], total: 1, page: 1, pageSize: 20 });
  liveStub.push("pipeline.counts", {
    counts: { running: 0, "awaiting-human": 0, completed: 0, failed: 1, cancelled: 0 },
    total: 1,
  });
  // The tab counter shows the pushed total.
  await expect(
    page
      .getByRole("tablist", { name: "Pipelines", exact: true })
      .getByRole("tab", { name: /^Läufe/ }),
  ).toHaveText(/^Läufe\s*1$/);
  await expect(page.getByText("Pushed failed run")).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Status", exact: true })
      .getByRole("button", { name: /^Fehlgeschlagen/ }),
  ).toHaveText(/^Fehlgeschlagen\s*1$/);
  expect(listings).toEqual([]);
});

for (const [language, groupLabel, pending, decisionLabel] of [
  ["de", "Aktive Pipelines", "1 Entscheidung", "Entscheidung erforderlich"],
  ["en", "Active pipelines", "1 decision", "Decision required"],
]) {
  test(`the sidebar follows active pipelines and opens a pending decision (${language})`, async ({
    page,
    liveStub,
  }) => {
    const phone = language === "en";
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (lang) => localStorage.setItem("agentpier-language", lang),
      language,
    );
    const state = await pipelinesFixture(page);
    const review = { ...sampleRun(state), task: "# Review navigation" };
    const build = {
      ...sampleRun(state, "run-build"),
      task: "Build dashboard",
      status: "running",
    };
    await page.goto(baseURL + "/inbox");
    await pushState(page, liveStub);
    if (phone) await page.getByRole("button", { name: "Open navigation" }).click();
    const topic = "pipeline.active";
    await liveStub.waitForSubscribe(topic);
    const group = page.locator(".pipeline-runs-group");
    liveStub.push(topic, { runs: [] });
    await expect(group).toHaveCount(0);
    liveStub.push(topic, { runs: [{ ...review, status: "running" }, build] });
    const toggle = group.getByRole("button", { name: groupLabel, exact: true });
    await toggle.click();
    liveStub.push(topic, { runs: [review, build] });
    const alertToggle = group.getByRole("button", { name: `${groupLabel}, ${pending}` });
    await expect(alertToggle).toHaveAttribute("aria-expanded", "false");
    await expect(alertToggle.getByText(pending, { exact: true })).toBeVisible();
    await alertToggle.click();
    const link = group.getByRole("link", { name: `Review navigation ${decisionLabel}` });
    await expect(group.getByRole("link").first()).toHaveAttribute(
      "href",
      "/pipelines/runs/run-one",
    );
    await link.click();
    await expect(page).toHaveURL(/\/pipelines\/runs\/run-one$/);
    await liveStub.waitForSubscribe("pipeline.run:run-one");
    liveStub.push("pipeline.run:run-one", { run: review });
    await expect(page.locator(".run-header-status")).toHaveText(decisionLabel);
    if (phone) {
      await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
      await page.getByRole("button", { name: "Open navigation" }).click();
    }
    await expect(link).toHaveAttribute("aria-current", "page");
    liveStub.push(topic, { runs: [build] });
    await expect(link).toHaveCount(0);
    await expect(toggle).toBeVisible();
    liveStub.push(topic, { runs: [] });
    await expect(group).toHaveCount(0);
    expect(reads(state, "/pipeline-active-runs")).toEqual([]);
  });
}
