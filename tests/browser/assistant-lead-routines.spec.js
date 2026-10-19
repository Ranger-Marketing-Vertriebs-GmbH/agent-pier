import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { fixture } from "./providers-fixture.js";

// A permanent member "Scout" whose lead "Home" set up a routine on it; the owner
// sees who set it up and changes it like any routine.
const copy = {
  en: {
    region: "Routines",
    createdBy: "Created by Home",
    hint: "Home set up this routine. Its results also go to Home.",
    edit: "Edit routine",
    name: "Routine name",
    prompt: "Task prompt",
    save: "Save routine",
    writes: "May write",
    pause: "Pause routine",
    resume: "Resume routine",
    remove: "Remove routine",
    empty: "No routines yet.",
  },
  de: {
    region: "Routinen",
    createdBy: "Angelegt von Home",
    hint: "Home hat diese Routine angelegt. Ihre Ergebnisse gehen auch an Home.",
    edit: "Routine bearbeiten",
    name: "Routinenname",
    prompt: "Aufgabenbeschreibung",
    save: "Routine speichern",
    writes: "Darf schreiben",
    pause: "Routine pausieren",
    resume: "Routine fortsetzen",
    remove: "Routine entfernen",
    empty: "Noch keine Routinen.",
  },
};

async function setup(page, language) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    patches: [],
    routines: [
      {
        id: "routine-1",
        name: "Inbox check",
        prompt: "Check the shared inbox and report new requests.",
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
        status: "ready",
        enabled: true,
        revision: 1,
        writes: false,
        telegram: false,
        createdBy: { kind: "lead", leadId: "home", leadName: "Home" },
      },
    ],
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    let body = {};
    if (path === "/api/assistants")
      body = {
        assistants: [
          {
            id: "home",
            name: "Home",
            instructions: "Lead",
            model: { connectionId: "router", modelId: "model" },
            revision: 1,
            capabilities: { reminders: true, memory: true },
          },
          {
            id: "scout",
            name: "Scout",
            instructions: "Research",
            model: { connectionId: "router", modelId: "model" },
            revision: 1,
            capabilities: { reminders: true, memory: true },
            parentAssistantId: "home",
            teamMemberId: "member-1",
            lifetime: "permanent",
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
    else if (path === "/api/assistant-channels") body = { channels: [] };
    else if (path.endsWith("/routines")) body = { routines: state.routines };
    else if (path.includes("/routines/")) {
      const id = path.split("/").at(-1),
        item = state.routines.find((r) => r.id === id);
      if (method === "DELETE") state.routines = state.routines.filter((r) => r.id !== id);
      else {
        const patch = route.request().postDataJSON();
        state.patches.push(patch);
        const { revision: _revision, ...change } = patch;
        Object.assign(item, change, { revision: item.revision + 1 });
      }
      body = item || {};
    }
    await route.fulfill({ json: body });
  });
  return state;
}

const cases = [
  ["en", "desktop", null],
  ["en", "390px", { width: 390, height: 844 }],
  ["de", "desktop", null],
  ["de", "390px", { width: 390, height: 844 }],
];
for (const [language, size, viewport] of cases)
  test(`${language} ${size}: the owner sees and changes a routine the lead set up`, async ({
    page,
  }) => {
    const t = copy[language];
    if (viewport) await page.setViewportSize(viewport);
    const state = await setup(page, language);
    await page.goto(baseURL + settingsPath("routines", undefined, "scout"));
    const panel = page.getByRole("region", { name: t.region });
    await expect(panel.getByText(t.createdBy)).toBeVisible();
    await panel.getByRole("button", { name: /^Inbox check/ }).click();
    await expect(panel.getByText(t.hint)).toBeVisible();
    // Edit name and task in place.
    await panel.getByRole("button", { name: t.edit }).click();
    await panel.getByLabel(t.name).fill("Morning inbox");
    await panel.getByLabel(t.prompt).fill("Report only urgent requests.");
    await panel.getByRole("button", { name: t.save }).click();
    await expect
      .poll(() => state.patches[0])
      .toEqual({
        name: "Morning inbox",
        prompt: "Report only urgent requests.",
        revision: 1,
      });
    await expect(panel.getByText("Report only urgent requests.")).toBeVisible();
    // Only the owner switches "May write".
    await panel.getByRole("switch", { name: t.writes }).click();
    await expect(panel.getByRole("switch", { name: t.writes })).toBeChecked();
    await expect.poll(() => state.patches[1]).toEqual({ writes: true, revision: 2 });
    await panel.getByRole("button", { name: t.pause }).click();
    await expect(panel.getByRole("button", { name: t.resume })).toBeVisible();
    if (viewport)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
    await panel.getByRole("button", { name: t.remove }).click();
    await expect(panel.getByText(t.empty)).toBeVisible();
  });
