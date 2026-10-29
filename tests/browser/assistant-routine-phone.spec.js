import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { connectedChannel } from "../helpers/assistant-settings-browser.js";
import { fixture } from "./providers-fixture.js";

const projectId = "6412b4c7ba0ddbae370e40834ea4319555c6dc94f79742b4ac4f3a1b2c3d4e5f";
const routine = {
  id: "routine-1",
  name: "Studio check before publishing",
  prompt: `Read the business project (${projectId}) before every check and report blockers.`,
  trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
  status: "ready",
  enabled: true,
  writes: false,
  revision: 1,
  lastRunStatus: "error",
  lastFailure: {
    reason: "gateway-restart",
    message: "cron: job interrupted by gateway restart",
    atMs: Date.UTC(2026, 9, 25, 7, 0),
    consecutive: 1,
  },
};

async function setup(page, language, updates) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = {};
    if (path === "/api/assistants")
      body = {
        assistants: [
          {
            id: "home",
            name: "Studio Lead",
            instructions: "Help",
            model: { connectionId: "router", modelId: "model" },
            revision: 1,
            capabilities: { reminders: true, memory: false },
          },
        ],
        conversations: [],
        models: [{ id: "router", name: "Router", available: true }],
      };
    else if (path === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    else if (path === "/api/assistant-channels")
      body = { channels: [connectedChannel()] };
    else if (path.endsWith("/routines")) body = { routines: [routine] };
    else if (path.endsWith("/routines/routine-1")) {
      updates.push(request.postDataJSON());
      body = { routine: { ...routine, ...request.postDataJSON() } };
    }
    await route.fulfill({ json: body });
  });
}

const fits = (page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const card = document.querySelector("#agent-routines .agent-detail");
    const scroller = document.querySelector(".assistant-settings-scroll");
    return {
      page: root.scrollWidth <= root.clientWidth,
      card: card.scrollWidth <= card.clientWidth,
      scroller: scroller.scrollWidth <= scroller.clientWidth,
    };
  });

for (const [language, routines, writes, name] of [
  ["en", "Routines", "May write", /^Studio check/],
  ["de", "Routinen", "Darf schreiben", /^Studio check/],
]) {
  test.describe(`routine card on phones (${language})`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("an expanded routine stays inside the screen and its switch works", async ({
      page,
    }) => {
      const updates = [];
      await setup(page, language, updates);
      await page.goto(baseURL + settingsPath("routines"));
      const panel = page.getByRole("region", { name: routines });
      await panel.getByRole("button", { name }).click();
      await expect(panel.getByText(projectId, { exact: false })).toBeVisible();
      expect(await fits(page)).toEqual({ page: true, card: true, scroller: true });
      const toggle = panel.getByRole("switch", { name: writes });
      await toggle.scrollIntoViewIfNeeded();
      const box = await toggle.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      await toggle.click();
      await expect.poll(() => updates.some((u) => u.writes === true)).toBe(true);
    });
  });
}
