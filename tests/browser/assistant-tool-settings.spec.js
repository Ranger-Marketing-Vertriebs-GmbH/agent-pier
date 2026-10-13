import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  setupAssistantSettings,
} from "../helpers/assistant-settings-browser.js";
import { agentTab, saveBar, settingsPath } from "../helpers/agent-settings-page.js";

// The owner's agent: memory and reminders on, no paired Telegram chat. The bot token is
// stored, but the chat was never paired: the server refuses to switch check-ins on.
const owner = {
  capabilities: { memory: true, reminders: true },
  heartbeatChannel: false,
};
const unpaired = () => connectedChannel({ enabled: false, chatId: null });
const copy = {
  en: {
    tools: ["Search the web", "Read web pages", "Use a browser", "Read images"],
    capabilities: "Capabilities",
    heartbeat: "Check in on its own",
    reason: "Needs a paired Telegram chat for this agent.",
    save: "Save agent",
    bar: "Unsaved changes",
    notices: "Language of Telegram notices",
    refusal: "Check-ins need a paired Telegram chat.",
  },
  de: {
    tools: ["Im Web suchen", "Webseiten lesen", "Einen Browser nutzen", "Bilder lesen"],
    capabilities: "Fähigkeiten",
    heartbeat: "Sich von selbst melden",
    reason: "Braucht einen verbundenen Telegram-Chat für diesen Agenten.",
    save: "Agent speichern",
    bar: "Ungespeicherte Änderungen",
    notices: "Sprache der Telegram-Hinweise",
    refusal: "Check-ins brauchen einen verbundenen Telegram-Chat.",
  },
};
const tool = (page, name) => page.getByRole("switch", { name: new RegExp(`^${name}`) });
const proactivity = (page) => page.locator("#agent-proactivity");
// The bot's rows render once the channel has loaded; only then is the switch settled.
const channelLoaded = (page, language = "en") =>
  expect(page.getByLabel(copy[language].notices)).toBeVisible();

/** The server's rules: check-ins without a chat refuse the whole save, else it is stored. */
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
    if (fields.heartbeat?.enabled && !state.paired)
      return route.fulfill({ status: 409, json: { error: copy[language].refusal } });
    state.assistants[0] = { ...current, ...fields, revision: current.revision + 1 };
    return route.fulfill({ json: state.assistants[0] });
  });
  await page.route(/\/api\/assistant-web-search$/, (route) =>
    route.fulfill({ json: { revision: 0, provider: "duckduckgo", ready: true } }),
  );
  state.paired = Boolean(state.channel?.enabled && state.channel?.chatId);
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
    // Check-ins would refuse a save without a paired chat: not offered, and say why.
    await agentTab(page, "Telegram").click();
    await channelLoaded(page, language);
    const heartbeat = proactivity(page).getByRole("switch", { name: text.heartbeat });
    await expect(heartbeat).toBeDisabled();
    await expect(heartbeat).not.toBeChecked();
    await expect(proactivity(page)).toContainText(text.reason);
  });
}

test("check-ins become available once the chat is paired", async ({ page }) => {
  const state = await setup(page, "en");
  await page.goto(baseURL + settingsPath("telegram"));
  await channelLoaded(page);
  const heartbeat = proactivity(page).getByRole("switch", { name: copy.en.heartbeat });
  await expect(heartbeat).toBeDisabled();
  // Paired elsewhere: the polled channel changes, the agent's chat test follows.
  state.channel = connectedChannel();
  state.paired = true;
  state.assistants[0] = { ...state.assistants[0], heartbeatChannel: true };
  await expect(heartbeat).toBeEnabled();
  await heartbeat.check();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.assistants[0].revision).toBe(2);
  expect(state.updates.at(-1).heartbeat.enabled).toBe(true);
});

test("a refused save shows its reason in the save bar and keeps the draft", async ({
  page,
}) => {
  // A chat paired in the editor's view, unpaired on the server meanwhile.
  const state = await setup(page, "en", {
    assistant: { ...owner, heartbeatChannel: true },
    channel: connectedChannel(),
  });
  state.paired = false;
  await page.goto(baseURL + settingsPath("telegram"));
  const heartbeat = proactivity(page).getByRole("switch", { name: copy.en.heartbeat });
  await heartbeat.check();
  await page.getByLabel(copy.en.notices).selectOption("de");
  const bar = saveBar(page);
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  await expect(bar.getByRole("alert")).toContainText(copy.en.refusal);
  await expect(bar.getByRole("alert")).toBeInViewport();
  // Nothing of the refused save is dropped from the form, and nothing else was sent.
  await expect(heartbeat).toBeChecked();
  await expect(page.getByLabel(copy.en.notices)).toHaveValue("de");
  expect(state.channelPatches).toEqual([]);
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
