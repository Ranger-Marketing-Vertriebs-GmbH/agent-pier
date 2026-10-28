import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// The agent list arrives on the live channel's `agent.list` topic as rows: a snapshot,
// then deltas (the stub encodes them with the server's own ChatSync). A change never
// reads the list over HTTP; a `stale` frame reads the list and the runtime once.
test.use({ live: "manual" });

const agent = (id, name) => ({
  id,
  name,
  model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
  revision: 1,
  effectiveRevision: 1,
});
const list = (extra = {}) => ({
  assistants: [agent("home", "Home assistant")],
  conversations: [{ id: "dinner", assistantId: "home" }],
  models: [{ id: "router", name: "OpenRouter", available: true }],
  teams: [],
  members: [],
  requests: [],
  policies: {},
  teamSettings: { revision: 0, hostMaxConcurrent: 8 },
  activity: {},
  runtime: { availability: "ready", sync: "current" },
  ...extra,
});
const working = {
  state: "working",
  reason: "team",
  label: "teamActive.working",
  pendingApprovals: 0,
  team: "active",
};
const waiting = {
  state: "waiting",
  reason: "approval",
  label: null,
  pendingApprovals: 1,
};

async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const reads = { list: 0, runtime: 0 };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/assistants") {
      reads.list++;
      const { runtime: _runtime, ...body } = list({
        assistants: [agent("home", "Home planner")],
      });
      return route.fulfill({ json: body });
    }
    if (p === "/api/assistant-runtime") {
      reads.runtime++;
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    }
    return route.fallback();
  });
  return reads;
}

for (const [name, size, touch] of [
  ["desktop", { width: 1440, height: 1000 }, false],
  ["phone", { width: 390, height: 844 }, true],
])
  test.describe(name, () => {
    test.use({ viewport: size, hasTouch: touch, isMobile: touch });

    test("the sidebar follows list deltas without reading the list", async ({
      page,
      liveStub,
    }) => {
      const reads = await setup(page);
      await page.goto(baseURL);
      await liveStub.waitForSubscribe("agent.list");
      liveStub.push("agent.list", list());
      if (touch)
        await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      const rows = page.locator(".assistant-sidebar-row");
      await expect(rows).toHaveCount(1);
      await expect(rows.first().locator("strong").first()).toHaveText("Home assistant");

      // A turn starts, a second agent appears, an approval waits: deltas only.
      const steps = [
        list({ activity: { home: working } }),
        list({
          assistants: [agent("home", "Home assistant"), agent("scout", "Scout")],
          activity: { home: working },
        }),
        list({
          assistants: [agent("home", "Home assistant"), agent("scout", "Scout")],
          activity: { home: waiting },
        }),
      ];
      for (const value of steps) {
        liveStub.push("agent.list", value);
        if (value === steps[0]) {
          const dot = rows.first().locator(".activity-dot");
          await expect(dot).toHaveClass(/working/);
          await expect(
            rows.first().locator(".assistant-sidebar-item small").first(),
          ).toHaveText("Team working");
        }
        if (value === steps[1]) await expect(rows).toHaveCount(2);
      }
      await expect(rows.first().locator(".activity-dot")).toHaveClass(/waiting/);
      await expect(rows.nth(1).locator("strong").first()).toHaveText("Scout");
      const frames = liveStub
        .received()
        .filter((frame) => frame.topic === "agent.list" && frame.op === "sub");
      expect(frames).toHaveLength(1);
      expect(reads).toEqual({ list: 0, runtime: 0 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    });

    test("a stale agent list reads the list and the runtime once", async ({
      page,
      liveStub,
    }) => {
      const reads = await setup(page);
      await page.goto(baseURL);
      await liveStub.waitForSubscribe("agent.list");
      liveStub.push("agent.list", list());
      if (touch)
        await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      const rows = page.locator(".assistant-sidebar-row");
      await expect(rows.first().locator("strong").first()).toHaveText("Home assistant");
      liveStub.stale("agent.list");
      await expect(rows.first().locator("strong").first()).toHaveText("Home planner");
      expect(reads).toEqual({ list: 1, runtime: 1 });
    });
  });
