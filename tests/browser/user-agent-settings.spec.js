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
    managed: "Das verwaltet dein Besitzer.",
    sharedManaged: /verwaltet der Besitzer für alle/,
    webSearch: "Websuche",
    memory: "Gedächtnis",
    deleteNote: "Notiz 2026-10-20.md löschen",
    deleteNow: "Jetzt löschen",
  },
  en: {
    title: "Settings of Lotta",
    level: (name) => `Your level: ${name}. Set by the owner.`,
    levels: { chat: "Chat only", personalize: "Personalize", extended: "Extended" },
    name: "Name",
    instructions: "Personality and instructions",
    save: "Save",
    addReminder: "+ Create reminder",
    managed: "Your owner manages this.",
    sharedManaged: /manages a shared agent for everyone/,
    webSearch: "Web search",
    memory: "Memory",
    deleteNote: "Delete note 2026-10-20.md",
    deleteNow: "Delete now",
  },
};

const note = {
  files: [{ name: "memory/2026-10-20.md", size: 10, modifiedAt: "2026-10-20T09:00:00Z" }],
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
      await page.getByRole("button", { name: new RegExp(copy.memory) }).click();
      await expect(page.getByText("2026-10-20.md")).toBeVisible();
      await expect(page.getByRole("button", { name: copy.deleteNote })).toHaveCount(0);
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
      await expect(page.getByText("Telegram")).toBeVisible();
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
      await expect(page.getByText("Telegram")).toHaveCount(0);
    });
  });
