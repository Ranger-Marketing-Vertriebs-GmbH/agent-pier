import { test, expect } from "@playwright/test";
import { fixture } from "./providers-fixture.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

const home = {
  id: "home",
  name: "Home",
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: true, reminders: false, browser: true },
};

// A stand-in for the server that keeps the switch a PATCH stores on the profile.
async function setup(page, { language = "en", agent = {} } = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = { agent: { ...home, ...agent }, patches: [] };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants/home" && request.method() === "PATCH") {
      const body = request.postDataJSON();
      state.patches.push(body);
      state.agent = {
        ...state.agent,
        ...body,
        capabilities: { ...state.agent.capabilities, ...body.capabilities },
        revision: state.agent.revision + 1,
      };
      return route.fulfill({ json: { ...state.agent, pending: false } });
    }
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [state.agent],
          conversations: [],
          models: [{ id: "router", name: "Router", available: true }],
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({
        json: { availability: "ready", sync: "current", browser: { available: true } },
      });
    return route.fulfill({ json: {} });
  });
  return state;
}

test("the owner turns shopping off and on per agent, and sees why it is unavailable", async ({
  page,
}, testInfo) => {
  const state = await setup(page);
  await page.goto(settingsPath("capabilities"));
  const shopping = page.getByRole("switch", { name: "Shopping", exact: true });
  // On by default for an agent with browser and memory.
  await expect(shopping).toBeChecked();
  await expect(shopping).toBeEnabled();
  await shopping.click();
  await expect(shopping).not.toBeChecked();
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toEqual({ shopping: false, revision: 1 });
  await expect(saveBar(page)).toBeHidden();
  await expect(shopping).not.toBeChecked();
  const screenshot = testInfo.outputPath("shopping-switch.png");
  await page
    .getByRole("region", { name: "Shopping", exact: true })
    .screenshot({ path: screenshot });
  await testInfo.attach("shopping-switch", {
    path: screenshot,
    contentType: "image/png",
  });
  await shopping.click();
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.patches.length).toBe(2);
  expect(state.patches[1]).toEqual({ shopping: true, revision: 2 });

  // Without a browser the switch explains why it is off.
  await page.getByRole("switch", { name: "Use a browser", exact: true }).click();
  await expect(shopping).toBeDisabled();
  await expect(shopping).not.toBeChecked();
  await expect(page.getByText("Needs “Use a browser”.")).toBeVisible();
  await page.getByRole("switch", { name: "Use a browser", exact: true }).click();
  await page.getByRole("switch", { name: "Remember information", exact: true }).click();
  await expect(shopping).toBeDisabled();
  await expect(page.getByText("Needs “Remember information”.")).toBeVisible();
});

test("an agent of users shows that it never shops", async ({ page }) => {
  await setup(page, { agent: { userAccess: { mode: "shared", members: [] } } });
  await page.goto(settingsPath("capabilities"));
  const shopping = page.getByRole("switch", { name: "Shopping", exact: true });
  await expect(shopping).toBeDisabled();
  await expect(shopping).not.toBeChecked();
  await expect(page.getByText("Agents of users never shop.")).toBeVisible();
});

test("the shopping switch in German", async ({ page }) => {
  await setup(page, { language: "de", agent: { shopping: false } });
  await page.goto(settingsPath("capabilities"));
  const shopping = page.getByRole("switch", { name: "Einkaufen", exact: true });
  await expect(shopping).not.toBeChecked();
  await expect(shopping).toBeEnabled();
  await expect(
    page.getByRole("region", { name: "Einkaufen", exact: true }),
  ).toContainText("nach deinem Ja");
});
