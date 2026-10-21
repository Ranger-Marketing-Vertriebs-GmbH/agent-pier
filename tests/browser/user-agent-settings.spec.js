import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { userAgent, userAppFixture } from "../helpers/user-app-fixture.js";

// A user's agent settings by level (user-agent-settings.js) at 390px.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = {
  de: {
    title: "Einstellungen von Lotta",
    level: (name) => `Deine Stufe: ${name}. Vergeben vom Besitzer.`,
    levels: {
      chat: "Nur chatten",
      personalize: "Personalisieren",
      extended: "Erweitert",
    },
    name: "Name",
    instructions: "Persönlichkeit und Anweisungen",
    save: "Speichern",
    addReminder: "+ Erinnerung erstellen",
    managed: "Das verwaltet der Besitzer.",
    remindersChatOnly: /Erinnerungen anlegen oder ändern kannst du ab der Stufe/,
    askInChat: /im Chat beauftragen|im Chat mit deinem Agenten an/,
    sharedManaged: /verwaltet der Besitzer für alle/,
    webSearch: "Websuche",
    memory: "Gedächtnis",
    deleteNote: "Notiz 2026-10-20.md löschen",
    deleteNow: "Jetzt löschen",
    token: "Telegram-Bot-Token",
    connect: "Telegram verbinden",
    disconnect: "Bot trennen",
    telegramPaired: "Verbunden mit @lotta_bot",
  },
  en: {
    title: "Settings of Lotta",
    level: (name) => `Your level: ${name}. Set by the owner.`,
    levels: { chat: "Chat only", personalize: "Personalize", extended: "Extended" },
    name: "Name",
    instructions: "Personality and instructions",
    save: "Save",
    addReminder: "+ Create reminder",
    managed: "The owner manages this.",
    remindersChatOnly: /setting up or changing reminders needs the Personalize level/,
    askInChat: /ask for reminders in chat|Ask your agent in the chat/,
    sharedManaged: /manages a shared agent for everyone/,
    webSearch: "Web search",
    memory: "Memory",
    deleteNote: "Delete note 2026-10-20.md",
    deleteNow: "Delete now",
    token: "Telegram bot token",
    connect: "Connect Telegram",
    disconnect: "Disconnect bot",
    telegramPaired: "Connected to @lotta_bot",
  },
};

const note = {
  files: [{ name: "memory/2026-10-20.md", size: 10, modifiedAt: "2026-10-20T09:00:00Z" }],
  contents: { "memory/2026-10-20.md": "Booked the dentist for Tuesday." },
};

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test("at Chat only she sees her settings read-only", async ({ page }) => {
      const state = await userAppFixture(page, { language, memory: { lotta: note } });
      await page.goto(baseURL + "/agents/lotta/settings");
      await expect(
        page.getByRole("heading", { level: 1, name: copy.title }),
      ).toBeVisible();
      await expect(page.getByText(copy.level(copy.levels.chat))).toBeVisible();
      await expect(page.getByLabel(copy.name, { exact: true })).toHaveCount(0);
      await page
        .getByRole("button", { name: /Hinweis anzeigen|Show hint/ })
        .first()
        .click();
      await expect(page.getByText(copy.managed).first()).toBeVisible();
      await expect(page.getByRole("button", { name: copy.addReminder })).toHaveCount(0);
      // Her agent cannot set reminders up at Chat only: no hint says to ask it.
      for (const hint of await page
        .getByRole("button", { name: /Hinweis anzeigen|Show hint/ })
        .all())
        if ((await hint.getAttribute("aria-expanded")) === "false") await hint.click();
      await expect(page.getByText(copy.remindersChatOnly)).toBeVisible();
      await expect(page.getByText(copy.askInChat)).toHaveCount(0);
      await page.getByRole("button", { name: new RegExp(copy.memory) }).click();
      await expect(page.getByText("2026-10-20.md")).toBeVisible();
      await expect(page.getByRole("button", { name: copy.deleteNote })).toHaveCount(0);
      // Every note opens to read, at every level.
      await page.getByText("2026-10-20.md").click();
      const reader = page.getByRole("dialog", { name: "2026-10-20.md" });
      await expect(reader.getByText("Booked the dentist for Tuesday.")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(reader).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      expect(state.foreign).toEqual([]);
    });

    test("from Personalize she edits her own agent's profile and notes", async ({
      page,
    }) => {
      const state = await userAppFixture(page, {
        language,
        agents: [userAgent({ level: "personalize" })],
        memory: { lotta: note },
      });
      await page.goto(baseURL + "/agents/lotta/settings");
      await expect(page.getByText(copy.level(copy.levels.personalize))).toBeVisible();
      await page.getByLabel(copy.name, { exact: true }).fill("Lotta Sun");
      await page.getByLabel(copy.instructions).fill("Friendly and brief.");
      await page.getByRole("button", { name: copy.save, exact: true }).click();
      await expect(
        page.getByRole("button", { name: copy.save, exact: true }),
      ).toHaveCount(0);
      expect(state.saved).toEqual([
        {
          id: "lotta",
          values: { name: "Lotta Sun", instructions: "Friendly and brief." },
        },
      ]);
      await expect(
        page.getByRole("button", { name: copy.addReminder }).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: new RegExp(copy.memory) }).click();
      await page.getByRole("button", { name: copy.deleteNote }).click();
      await page.getByRole("button", { name: copy.deleteNow, exact: true }).click();
      await expect(page.getByText("2026-10-20.md")).toHaveCount(0);
      expect(state.foreign).toEqual([]);
    });

    test("at Extended she switches the capabilities the owner released", async ({
      page,
    }) => {
      const state = await userAppFixture(page, {
        language,
        agents: [userAgent({ level: "extended", released: ["webSearch"] })],
      });
      await page.goto(baseURL + "/agents/lotta/settings");
      await expect(page.getByText(copy.level(copy.levels.extended))).toBeVisible();
      await page.getByRole("switch", { name: copy.webSearch }).check();
      await page.getByRole("button", { name: copy.save, exact: true }).click();
      await expect(
        page.getByRole("button", { name: copy.save, exact: true }),
      ).toHaveCount(0);
      expect(state.saved).toEqual([
        { id: "lotta", values: { capabilities: { webSearch: true } } },
      ]);
      await expect(page.getByText("Telegram", { exact: true })).toBeVisible();
    });

    test("at Extended she connects, pairs and disconnects her bot", async ({ page }) => {
      const state = await userAppFixture(page, {
        language,
        agents: [userAgent({ level: "extended" })],
      });
      await page.goto(baseURL + "/agents/lotta/settings");
      await page.getByLabel(copy.token, { exact: true }).fill("123:secret");
      await page.getByRole("button", { name: copy.connect, exact: true }).click();
      await expect(page.getByText("/start 123456")).toBeVisible();
      await expect(page.getByText("@lotta_bot", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: copy.disconnect, exact: true }).click();
      await expect(page.getByLabel(copy.token, { exact: true })).toBeVisible();
      expect(state.telegram.map((call) => call.method)).toEqual([
        "PUT",
        "POST",
        "DELETE",
      ]);
      expect(state.telegram[0].token).toBe("123:secret");
      expect(state.foreign).toEqual([]);
    });

    test("her bot's pairing finishing in Telegram shows at once", async ({ page }) => {
      const state = await userAppFixture(page, {
        language,
        agents: [userAgent({ level: "extended" })],
        eventRetry: 200,
      });
      await page.goto(baseURL + "/agents/lotta/settings");
      await page.getByLabel(copy.token, { exact: true }).fill("123:secret");
      await page.getByRole("button", { name: copy.connect, exact: true }).click();
      await expect(page.getByText("/start 123456")).toBeVisible();
      // She sends the code to her bot: the server pairs it and tells her app.
      state.telegramChannels.lotta = { ...state.telegramChannels.lotta, paired: true };
      state.events.push({ type: "telegram", agentId: "lotta" });
      await expect(page.getByText("/start 123456")).toHaveCount(0);
      await expect(page.getByText(copy.telegramPaired)).toBeVisible();
      expect(state.telegram.map((call) => call.method)).toEqual(["PUT", "POST"]);
      // Disconnected and connected again, the same bot is hers again without a code.
      await page.getByRole("button", { name: copy.disconnect, exact: true }).click();
      await page.getByLabel(copy.token, { exact: true }).fill("123:secret");
      await page.getByRole("button", { name: copy.connect, exact: true }).click();
      await expect(page.getByText(copy.telegramPaired)).toBeVisible();
      await expect(page.getByText(/\/start/)).toHaveCount(0);
      expect(state.telegram.map((call) => call.method)).toEqual([
        "PUT",
        "POST",
        "DELETE",
        "PUT",
      ]);
    });

    test("a shared agent stays the owner's at every level", async ({ page }) => {
      await userAppFixture(page, {
        language,
        agents: [userAgent({ shared: true, level: "extended", released: ["webSearch"] })],
      });
      await page.goto(baseURL + "/agents/lotta/settings");
      await expect(page.getByLabel(copy.name, { exact: true })).toHaveCount(0);
      await expect(page.getByRole("switch", { name: copy.webSearch })).toHaveCount(0);
      await page
        .getByRole("button", { name: /Hinweis anzeigen|Show hint/ })
        .first()
        .click();
      await expect(page.getByText(copy.sharedManaged).first()).toBeVisible();
      await expect(page.getByText("Telegram", { exact: true })).toHaveCount(0);
    });
  });
