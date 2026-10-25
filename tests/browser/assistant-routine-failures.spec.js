import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { connectedChannel } from "../helpers/assistant-settings-browser.js";
import { fixture } from "./providers-fixture.js";

const restart = "cron: job interrupted by gateway restart";
const refused =
  "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`. | 401";
const routine = {
  id: "routine-1",
  name: "Zabbix check",
  prompt: "Check the open Zabbix problems.",
  trigger: { kind: "cron", expr: "25 15 * * *", tz: "Europe/Berlin" },
  status: "ready",
  enabled: true,
  revision: 1,
  lastRunStatus: "error",
  lastFailure: {
    reason: "gateway-restart",
    message: restart,
    atMs: Date.UTC(2026, 9, 25, 13, 25),
    consecutive: 2,
  },
};
const runs = [
  { runAtMs: Date.UTC(2026, 9, 24, 13, 25), status: "ok", durationMs: 8000 },
  {
    runAtMs: Date.UTC(2026, 9, 25, 13, 25),
    status: "error",
    durationMs: 48955,
    failure: { reason: "gateway-restart", message: restart },
  },
  {
    runAtMs: Date.UTC(2026, 9, 25, 7, 25),
    status: "error",
    durationMs: 5480,
    failure: { reason: "model", message: refused },
  },
];

async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === "/api/assistants")
      body = {
        assistants: [
          {
            id: "home",
            name: "Network Architect",
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
    else if (path.endsWith("/routines/routine-1/runs")) body = { entries: runs };
    await route.fulfill({ json: body });
  });
}

test("a failed routine shows why in English, with OpenClaw's message on request", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("routines"));
  const panel = page.getByRole("region", { name: "Routines" });
  await expect(panel.getByText("Last run failed")).toBeVisible();
  await panel.getByRole("button", { name: /^Zabbix check/ }).click();
  const last = panel.locator('[data-routine-failure="gateway-restart"]').first();
  await expect(last).toContainText("The Gateway restarted during the run.");
  await expect(last).toContainText("Failed");
  // The raw message stays behind the disclosure.
  await expect(panel.getByText(restart)).toHaveCount(0);
  await last.getByRole("button", { expanded: false }).click();
  await expect(last.getByLabel("Error message", { exact: true })).toHaveText(restart);
  await expect(last).toContainText("2 failed runs in a row");
  await expect(last.getByRole("button", { name: "Copy error message" })).toBeVisible();

  // The history lists every run, newest first, failures with their cause.
  await panel.getByRole("button", { name: "Run history" }).click();
  const model = panel.locator('[data-routine-failure="model"]');
  await expect(model).toContainText("The model provider returned an error.");
  await model.getByRole("button", { expanded: false }).click();
  await expect(model.getByLabel("Error message", { exact: true })).toHaveText(refused);
  await expect(model).toContainText("5.5 s");
  await expect(panel.getByText(/· Completed$/)).toBeVisible();
  // On a phone the open rows and their messages fit the width.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const box = await model.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await panel.getByRole("button", { name: "Hide run history" }).click();
  await expect(model).toHaveCount(0);
});
