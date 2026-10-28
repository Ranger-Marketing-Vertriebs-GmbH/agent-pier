import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { recordApiRequests } from "../helpers/visibility.js";

// The sidebar follows the live `state` topic (useWorkspaceState): pushed rows reach it
// without a REST read, and `stale` costs exactly one GET /api/state. The stub sends a
// later push of a rows topic as a delta (live-stub.spec.js checks the frames).
test.use({ live: "manual" });

const session = (id, name) => ({
  id,
  name,
  tool: "codex",
  accountId: "local-codex",
  cwd: `/work/${id}`,
  status: "running",
  activity: { state: "idle", label: "Bereit" },
});
const stateOf = (sessions) => ({
  tools: [],
  accounts: [{ id: "local-codex", tool: "codex", name: "Lokal", kind: "local" }],
  sessions,
  home: "/work",
});
const sessionList = (page) => page.locator(".sessions-group .session-list");
const statePath = "/api/state";

async function open(page, liveStub, restSessions) {
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === statePath
          ? stateOf(restSessions)
          : path === "/api/pipeline-runs"
            ? { runs: [], total: 0, page: 1, pageSize: 20 }
            : {},
    });
  });
  const requests = recordApiRequests(page);
  await page.goto(base);
  await liveStub.waitForSubscribe("state");
  liveStub.push("state", stateOf([session("first", "Projekt Eins")]));
  await expect(sessionList(page).getByText("Projekt Eins")).toBeVisible();
  const stateReads = () => requests.list().filter(({ path }) => path === statePath);
  return { stateReads };
}

test("a pushed state delta adds a session row without GET /api/state", async ({
  page,
  liveStub,
}) => {
  const { stateReads } = await open(page, liveStub, []);
  liveStub.push(
    "state",
    stateOf([session("first", "Projekt Eins"), session("second", "Projekt Zwei")]),
  );
  await expect(sessionList(page).getByText("Projekt Zwei")).toBeVisible();
  await expect(sessionList(page).getByText("Projekt Eins")).toBeVisible();
  expect(stateReads()).toEqual([]);
});

test("stale costs exactly one GET /api/state", async ({ page, liveStub }) => {
  const { stateReads } = await open(page, liveStub, [session("rest", "Projekt Rest")]);
  expect(stateReads()).toEqual([]);
  liveStub.stale("state");
  await expect(sessionList(page).getByText("Projekt Rest")).toBeVisible();
  await expect(sessionList(page).getByText("Projekt Eins")).toHaveCount(0);
  // Nothing polls afterwards.
  await page.waitForTimeout(3500);
  expect(stateReads()).toEqual([{ method: "GET", path: statePath }]);
});
