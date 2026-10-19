import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import { listRows } from "../../server/features/assistants/assistant-list-feed.js";

// The agent list arrives as sync frames on /api/assistant-events
// (assistant-list-feed.js), encoded here by the server's own ChatSync. A change
// never reads the whole list over HTTP; only the page start does, once.
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
  await page.addInitScript(() => {
    localStorage.setItem("agentpier-language", "en");
    const Native = window.EventSource;
    window.listStreams = [];
    window.EventSource = class {
      constructor(url) {
        if (!url.startsWith("/api/assistant-events")) return new Native(url);
        this.url = url;
        this.readyState = 1;
        window.listStreams.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {
        this.readyState = 2;
      }
    };
  });
  const reads = { list: 0, runtime: 0 };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/assistants") {
      reads.list++;
      return route.fulfill({ json: list() });
    }
    if (p === "/api/assistant-runtime") {
      reads.runtime++;
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    }
    return route.fallback();
  });
  return reads;
}

/** Sends events on the newest stream. */
const emit = (page, ...events) =>
  page.evaluate((events) => {
    const stream = window.listStreams.at(-1);
    for (const event of events) stream.onmessage({ data: JSON.stringify(event) });
  }, events);

for (const [name, size, touch] of [
  ["desktop", { width: 1440, height: 1000 }, false],
  ["phone", { width: 390, height: 844 }, true],
])
  test.describe(name, () => {
    test.use({ viewport: size, hasTouch: touch, isMobile: touch });

    test("the sidebar follows list diffs without reading the whole list", async ({
      page,
    }) => {
      const reads = await setup(page);
      const sync = new ChatSync({});
      await page.goto(baseURL);
      await page.waitForFunction(() => window.listStreams?.length === 1);
      await expect.poll(() => reads.list).toBe(1);
      let frame = sync.encodeScoped(["l"], listRows(list()));
      await emit(page, { type: "connected", list: true }, { type: "sync", data: frame });
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
        const next = sync.encodeScoped(["l"], listRows(value), frame.sync.cursor);
        expect(next.sync.mode).toBe("delta");
        await emit(
          page,
          { type: "change" },
          { type: "change" },
          { type: "sync", data: next },
        );
        frame = next;
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
      expect(reads).toEqual({ list: 1, runtime: 1 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);

      // A delta that does not fit the held list (a gap) reconnects without a cursor
      // and takes the whole list.
      const stale = sync.encodeScoped(["l"], listRows(list()), frame.sync.cursor);
      const skipped = sync.encodeScoped(
        ["l"],
        listRows(list({ activity: { home: working } })),
        stale.sync.cursor,
      );
      await emit(page, { type: "sync", data: skipped });
      await page.waitForFunction(() => window.listStreams.length === 2);
      expect(await page.evaluate(() => window.listStreams[1].url)).toBe(
        "/api/assistant-events",
      );
      await emit(
        page,
        { type: "connected", list: true },
        { type: "sync", data: new ChatSync({}).encodeScoped(["l"], listRows(list())) },
      );
      await expect(rows).toHaveCount(1);
      await expect(rows.first().locator(".activity-dot")).toHaveCount(0);
      expect(reads).toEqual({ list: 1, runtime: 1 });
    });

    test("a stream without the list feed reads the whole list on change", async ({
      page,
    }) => {
      const reads = await setup(page);
      await page.goto(baseURL);
      await page.waitForFunction(() => window.listStreams?.length === 1);
      await emit(page, { type: "connected" });
      await expect.poll(() => reads.list).toBe(2);
      await emit(page, { type: "change" });
      await expect.poll(() => reads.list).toBe(3);
    });
  });
