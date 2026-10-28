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
