import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { recordApiRequests, setTabHidden } from "../helpers/visibility.js";
import { topicInfo } from "../../web/lib/live/live-topics.js";
import { emptyInbox } from "../helpers/empty-inbox.js";
import { operationsFixture } from "./operations-fixture.js";

// The steady state of a page on a working live channel is push-only: after the first
// snapshots, nothing polls the workspace state, the native requests, the model state,
// the pipeline runs or the other menu-hint sources (the start page's pipelines card
// and hints; the run pages' own steady state is checked in
// pipelines-run-polling.spec.js). A hidden tab sends nothing and subscribes no sampled
// topic. With the channel refused, the old visible-only polling takes over.
test.use({ live: "manual" });

const requestsTopic = "session.requests:fixture-session";
const modelsTopic = "session.models:fixture-session";
const pages = {
  "session chat": {
    path: "/sessions/fixture-session/chat",
    topics: ["state", requestsTopic, modelsTopic],
  },
  "start page": {
    path: "/",
    topics: [
      "state",
      "inbox",
      "pipeline.counts",
      "pipeline.runs:*:awaiting-human",
      "pipeline.runs:*:failed",
      "pipeline.runs:*:running",
      "connections.problems",
      "settings.summary",
    ],
  },
};
const polled = [/^\/api\/state$/, /\/requests$/, /\/models$/];
const pipelineRuns = /^\/api\/pipeline-run(?:s|-counts)$/;
const menuHints = [
  pipelineRuns,
  /^\/api\/connections\/problems$/,
  /^\/api\/settings\/summary$/,
  /^\/api\/assistant-runtime\/updates$/,
];
const reads = (requests, patterns) =>
  requests
    .list()
    .filter(
      ({ method, path }) => method === "GET" && patterns.some((re) => re.test(path)),
    );

async function fixture(page) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await operationsFixture(page);
}

// Opens `path`, answers each subscription with its first snapshot, as the server
// would (a topic without a fixed snapshot gets what its REST route answers), and
// waits until the sidebar shows the pushed session.
async function openSteady(page, liveStub, { path, topics }) {
  await fixture(page);
  await page.goto(baseURL + path);
  await liveStub.waitForSubscribe("state");
  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  const snapshots = {
    state,
    inbox: emptyInbox,
    [requestsTopic]: { requests: [] },
    [modelsTopic]: { currentModel: "gpt-5", picker: null, pending: false },
  };
  for (const topic of topics) {
    await liveStub.waitForSubscribe(topic);
    const info = topicInfo(topic);
    liveStub.push(
      topic,
      snapshots[topic] ??
        (await page.evaluate(
          (path) => fetch(`/api${path}`).then((r) => r.json()),
          info.path(info.param),
        )),
    );
  }
  await expect(page.locator(".session-list").getByText("Fixture session")).toBeVisible();
}

for (const [name, target] of Object.entries(pages)) {
  test(`the ${name} reads no state, requests or models for 10 s`, async ({
    page,
    liveStub,
  }) => {
    test.setTimeout(30000);
    const requests = recordApiRequests(page);
    await openSteady(page, liveStub, target);
    requests.clear();
    await page.waitForTimeout(10000);
    expect(reads(requests, polled)).toEqual([]);
  });

  // The run lists, the counts and the other menu-hint sources are pushed.
  test(`the ${name} reads no pipeline runs or menu-hint sources for 10 s`, async ({
    page,
    liveStub,
  }) => {
    test.setTimeout(30000);
    const requests = recordApiRequests(page);
    await openSteady(page, liveStub, target);
    requests.clear();
    await page.waitForTimeout(10000);
    expect(reads(requests, menuHints)).toEqual([]);
  });
}

test("a hidden session chat sends no request and subscribes no sampled topic", async ({
  page,
  liveStub,
}) => {
  test.setTimeout(30000);
  const requests = recordApiRequests(page);
  await openSteady(page, liveStub, pages["session chat"]);
  const before = liveStub.received().length;
  await setTabHidden(page, true);
  await expect
    .poll(() => liveStub.subscriptions().filter((topic) => topicInfo(topic).sampled))
    .toEqual([]);
  requests.clear();
  await page.waitForTimeout(10000);
  expect(requests.list()).toEqual([]);
  const sampledSubs = liveStub
    .received()
    .slice(before)
    .filter(({ op, topic }) => op === "sub" && topicInfo(topic)?.sampled);
  expect(sampledSubs).toEqual([]);
  // Shown again, the sampled topics come back over the same socket.
  await setTabHidden(page, false);
  await expect.poll(() => liveStub.subscriptions()).toContain(modelsTopic);
  expect(liveStub.subscriptions()).toContain(requestsTopic);
});

test("a refused channel polls at the old interval after three handshakes, visible only", async ({
  page,
  liveStub,
}) => {
  test.setTimeout(45000);
  await fixture(page);
  const stateReads = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && pathname === "/api/state")
      stateReads.push({ at: Date.now(), handshakes: liveStub.connections() });
  });
  const requests = recordApiRequests(page);
  liveStub.refuse();
  await page.goto(baseURL + "/");
  await expect(page.locator(".session-list").getByText("Fixture session")).toBeVisible({
    timeout: 6000,
  });
  // The first REST read comes only after the third refused handshake.
  expect(stateReads[0].handshakes).toBeGreaterThanOrEqual(3);
  await expect
    .poll(() => stateReads.length, { timeout: 15000 })
    .toBeGreaterThanOrEqual(3);
  // The state's previous interval, 3 s, with room for a slow machine.
  const gaps = stateReads.slice(1, 3).map((read, i) => read.at - stateReads[i].at);
  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(2000);
    expect(gap).toBeLessThanOrEqual(6000);
  }
  // Hidden, the fallback polls nothing.
  await setTabHidden(page, true);
  requests.clear();
  await page.waitForTimeout(7000);
  expect(requests.list()).toEqual([]);
  // Shown again, it reads at once.
  const shownAt = stateReads.length;
  await setTabHidden(page, false);
  await expect.poll(() => stateReads.length, { timeout: 2000 }).toBeGreaterThan(shownAt);
});
