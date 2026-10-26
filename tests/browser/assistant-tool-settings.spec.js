import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  setupAssistantSettings,
} from "../helpers/assistant-settings-browser.js";
import { agentTab, saveBar, settingsPath } from "../helpers/agent-settings-page.js";

// The owner's agent: memory and reminders on. The bot token is stored, but the chat
// was never paired: check-ins still run in the agent's chat, only Telegram is missing.
const owner = { capabilities: { memory: true, reminders: true } };
const unpaired = () => connectedChannel({ enabled: false, chatId: null });
const copy = {
  en: {
    tools: ["Search the web", "Read web pages", "Use a browser", "Read images"],
    tab: "Automation",
    heartbeat: "Check in on its own",
    telegram: "Also send to Telegram",
    save: "Save agent",
    bar: "Unsaved changes",
    refusal: "Check-ins need memory.",
  },
  de: {
    tools: ["Im Web suchen", "Webseiten lesen", "Einen Browser nutzen", "Bilder lesen"],
    tab: "Automatisierung",
    heartbeat: "Sich von selbst melden",
    telegram: "Auch an Telegram senden",
    save: "Agent speichern",
    bar: "Ungespeicherte Änderungen",
    refusal: "Meldungen brauchen das Gedächtnis.",
  },
};
const tool = (page, name) => page.getByRole("switch", { name: new RegExp(`^${name}`) });
const proactivity = (page) => page.locator("#agent-proactivity");

/** The server stores every save; `refuse` answers check-ins with a 409 instead. */
async function setup(page, language, { assistant = owner, channel = unpaired() } = {}) {
  const state = await setupAssistantSettings(page, {
    language,
    assistant,
    channel,
    runtime: {
      availability: "ready",
      sync: "current",
      browser: { available: true, name: "Chrome" },
    },
  });
  await page.route(/\/api\/assistants\/home$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const { revision, ...fields } = route.request().postDataJSON();
    state.updates.push(fields);
    const current = state.assistants[0];
    if (revision !== current.revision)
      return route.fulfill({ status: 409, json: { error: "Revision conflict" } });
    if (fields.heartbeat?.enabled && state.refuse)
      return route.fulfill({ status: 409, json: { error: copy[language].refusal } });
    state.assistants[0] = { ...current, ...fields, revision: current.revision + 1 };
    return route.fulfill({ json: state.assistants[0] });
  });
  await page.route(/\/api\/assistant-web-search$/, (route) =>
    route.fulfill({ json: { revision: 0, provider: "duckduckgo", ready: true } }),
  );
  return state;
}

for (const language of ["en", "de"]) {
  const text = copy[language];
  test(`ticked web tools stay ticked after save and reload (${language})`, async ({
    page,
  }) => {
    const state = await setup(page, language);
    await page.goto(baseURL + settingsPath("capabilities"));
    for (const name of text.tools) await tool(page, name).check();
    await saveBar(page, text.bar).getByRole("button", { name: text.save }).click();
    await expect.poll(() => state.assistants[0].revision).toBe(2);
    expect(state.updates.at(-1).heartbeat).toBeUndefined();
    await page.reload();
    for (const name of text.tools) await expect(tool(page, name)).toBeChecked();
    // Check-ins need no Telegram chat: offered, without the Telegram extra.
    await agentTab(page, text.tab).click();
    const heartbeat = proactivity(page).getByRole("switch", { name: text.heartbeat });
    await expect(heartbeat).toBeEnabled();
    await expect(heartbeat).not.toBeChecked();
    await heartbeat.check();
    await expect(
      proactivity(page).getByRole("switch", { name: text.telegram }),
    ).toHaveCount(0);
  });
}

test("pairing the chat offers check-ins in Telegram too", async ({ page }) => {
  const state = await setup(page, "en");
  await page.goto(baseURL + settingsPath("routines"));
  const heartbeat = proactivity(page).getByRole("switch", { name: copy.en.heartbeat });
  await heartbeat.check();
  const telegram = proactivity(page).getByRole("switch", { name: copy.en.telegram });
  await expect(telegram).toHaveCount(0);
  // Paired elsewhere: the polled channel changes and the Telegram extra appears.
  state.channel = connectedChannel();
  await expect(telegram).toBeChecked();
  await telegram.uncheck();
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.assistants[0].revision).toBe(2);
  expect(state.updates.at(-1).heartbeat).toMatchObject({
    enabled: true,
    telegram: false,
  });
});

test("a refused save shows its reason in the save bar and keeps the draft", async ({
  page,
}) => {
  const state = await setup(page, "en", { channel: connectedChannel() });
  state.refuse = true;
  await page.goto(baseURL + settingsPath("routines"));
  const heartbeat = proactivity(page).getByRole("switch", { name: copy.en.heartbeat });
  await heartbeat.check();
  const bar = saveBar(page);
  await bar.getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  await expect(bar.getByRole("alert")).toContainText(copy.en.refusal);
  await expect(bar.getByRole("alert")).toBeInViewport();
  // Nothing of the refused save is dropped from the form.
  await expect(heartbeat).toBeChecked();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the restart question for new web tools is in view", async ({ page }) => {
    const state = await setup(page, "en");
    await page.route(/\/api\/assistants\/home$/, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      state.updates.push(route.request().postDataJSON());
      return route.fulfill({
        status: 409,
        json: {
          code: "ASSISTANT_RESTART_REQUIRED",
          error: "Restart needed",
          affected: { agents: [{ id: "home", name: "Home" }], teamMembers: 0 },
        },
      });
    });
    await page.goto(baseURL + settingsPath("capabilities"));
    await tool(page, "Read web pages").check();
    await saveBar(page).getByRole("button", { name: "Save agent" }).click();
    await expect.poll(() => state.updates.length).toBe(1);
    const dialog = page.getByRole("dialog", { name: "Restart the agent service?" });
    await expect(dialog).toBeInViewport();
  });
});
