import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// The owner's chat list (AGENTPIER-181) at 390px: New chat, rename, archive, restore,
// delete, an archived chat read-only, and the last window of a chat while offline.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = {
  de: {
    chats: /Chats mit Home/,
    newChat: "Neuer Chat",
    actions: (title) => `Aktionen für ${title}`,
    rename: "Umbenennen",
    title: "Titel",
    save: "Speichern",
    archive: "Archivieren",
    restore: "Wiederherstellen",
    delete: "Löschen",
    deleteNow: "Jetzt löschen",
    deleteBody: "Der Chat und sein Verlauf werden entfernt.",
    archivedList: "Archivierte Chats",
    readOnly: /Archivierte Chats sind nur lesbar/,
    deleted: "Dieser Chat wurde gelöscht.",
    toMain: "Hauptchat öffnen",
    message: "Nachricht",
    offline: /Verbindung unterbrochen/,
    close: "Schließen",
  },
  en: {
    chats: /Chats with Home/,
    newChat: "New chat",
    actions: (title) => `Actions for ${title}`,
    rename: "Rename",
    title: "Title",
    save: "Save",
    archive: "Archive",
    restore: "Restore",
    delete: "Delete",
    deleteNow: "Delete now",
    deleteBody: "The chat and its transcript are removed.",
    archivedList: "Archived chats",
    readOnly: /Archived chats are read-only/,
    deleted: "This chat was deleted.",
    toMain: "Open main chat",
    message: "Message",
    offline: /Connection interrupted/,
    close: "Close",
  },
};

async function setup(page, language) {
  await fixture(page);
  await page.addInitScript((value) => {
    localStorage.setItem("agentpier-language", value);
    const Native = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (url !== "/api/assistant-events") return new Native(url);
        window.assistantTestStream = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    };
  }, language);
  const assistant = {
    id: "home",
    name: "Home",
    instructions: "",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 1,
    effectiveRevision: 1,
  };
  const state = {
    conversations: [
      {
        id: "main",
        assistantId: "home",
        main: true,
        title: "Dinner plans",
        lastActivityAt: "2026-10-20T09:00:00.000Z",
      },
    ],
    messages: { main: [{ id: "m1", role: "assistant", text: "Dinner is planned." }] },
    created: 0,
  };
  const summary = (c) => ({ ...c, archivedAt: c.archivedAt ?? null, busy: false });
  await page.route(/\/api\/(?:assistant|dictation)/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const method = request.method();
    const p = new URL(request.url()).pathname;
    if (["/api/assistant-channels", "/api/assistant-speech"].includes(p))
      return route.fallback();
    if (p === "/api/dictation") return route.fulfill({ json: { available: false } });
    if (p === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [assistant],
          conversations: state.conversations,
          models: [{ id: "router", name: "OpenRouter", available: true }],
          activity: {},
        },
      });
    if (p === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (p === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (p === "/api/assistants/home/chats" && method === "GET") {
      const archived = new URL(request.url()).searchParams.get("archived") === "1";
      return route.fulfill({
        json: state.conversations.filter((c) => !!c.archivedAt === archived).map(summary),
      });
    }
    if (p === "/api/assistants/home/chats" && method === "POST") {
      const chat = {
        id: `new-${++state.created}`,
        assistantId: "home",
        main: false,
        title: null,
        lastActivityAt: "2026-10-21T09:00:00.000Z",
      };
      state.conversations.push(chat);
      return route.fulfill({ status: 201, json: summary(chat) });
    }
    if (p === "/api/assistants/home/conversations")
      return route.fulfill({ json: { id: "main", assistantId: "home" } });
    const m = /^\/api\/assistant-conversations\/([^/]+)(\/.*)?$/.exec(p);
    if (m) {
      const chat = state.conversations.find((c) => c.id === m[1]);
      const rest = m[2] || "";
      // `/new` starts a chat on the server (chat-commands.js) and names it.
      if (rest === "/messages" && method === "POST") {
        if (request.postDataJSON().text.trim() !== "/new")
          return route.fulfill({ status: 202, json: { accepted: true } });
        const created = {
          id: `new-${++state.created}`,
          assistantId: "home",
          main: false,
          title: null,
          lastActivityAt: "2026-10-21T09:00:00.000Z",
        };
        state.conversations.push(created);
        return route.fulfill({ status: 201, json: { created: created.id } });
      }
      if (rest === "/messages")
        return route.fulfill({
          json: { messages: state.messages[m[1]] || [], requests: [], stale: false },
        });
      if (rest === "" && method === "PATCH") chat.title = request.postDataJSON().title;
      if (rest === "/archive") chat.archivedAt = "2026-10-21T10:00:00.000Z";
      if (rest === "/restore") chat.archivedAt = null;
      if (rest === "" && method === "DELETE") {
        state.conversations = state.conversations.filter((c) => c.id !== m[1]);
        return route.fulfill({ status: 204, body: "" });
      }
      if (rest === "/attachment-policy") return route.fulfill({ json: {} });
      return route.fulfill({ json: chat ? summary(chat) : {} });
    }
    return route.fulfill({ json: {} });
  });
  return state;
}

// A chat's row in the Chats sheet (its ⋯ button is named "Actions for …").
const row = (page, title) =>
  page.locator(".agent-chat-list .list-row-main", { hasText: title });
const openList = (page, copy) => page.getByRole("button", { name: copy.chats }).click();

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test("New chat starts an empty thread and the earlier chat stays reachable", async ({
      page,
    }) => {
      await setup(page, language);
      await page.goto(baseURL + "/agents/home/chats/main");
      await expect(page.getByText("Dinner is planned.")).toBeVisible();
      await page.getByRole("button", { name: copy.newChat, exact: true }).click();
      await expect(page).toHaveURL(/\/agents\/home\/chats\/new-1$/);
      await expect(page.getByText("Dinner is planned.")).toHaveCount(0);
      await openList(page, copy);
      const sheet = page.getByRole("dialog", { name: copy.chats });
      await row(sheet, "Dinner plans").click();
      await expect(page).toHaveURL(/\/agents\/home\/chats\/main$/);
      await expect(page.getByText("Dinner is planned.")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    });

    test("typing /new opens the chat it started", async ({ page }) => {
      await setup(page, language);
      await page.goto(baseURL + "/agents/home/chats/main");
      await expect(page.getByText("Dinner is planned.")).toBeVisible();
      await page.getByLabel(copy.message, { exact: true }).fill("/new");
      await page.getByRole("button", { name: /Senden|Send/ }).click();
      await expect(page).toHaveURL(/\/agents\/home\/chats\/new-1$/);
      await expect(page.getByText("Dinner is planned.")).toHaveCount(0);
    });

    test("rename, archive, restore and delete a chat", async ({ page }) => {
      const state = await setup(page, language);
      state.conversations.push({
        id: "trip",
        assistantId: "home",
        main: false,
        title: "Trip",
        lastActivityAt: "2026-10-20T08:00:00.000Z",
      });
      await page.goto(baseURL + "/agents/home/chats/main");
      await openList(page, copy);
      await page.getByRole("button", { name: copy.actions("Trip") }).click();
      await page.getByRole("button", { name: copy.rename, exact: true }).click();
      await page.getByLabel(copy.title, { exact: true }).fill("Summer trip");
      await page.getByRole("button", { name: copy.save, exact: true }).click();
      await expect(row(page, "Summer trip")).toBeVisible();
      await page.getByRole("button", { name: copy.actions("Summer trip") }).click();
      await page.getByRole("button", { name: copy.archive, exact: true }).click();
      await expect(row(page, "Summer trip")).toHaveCount(0);
      await page.getByRole("button", { name: copy.archivedList, exact: true }).click();
      await page.getByRole("button", { name: copy.actions("Summer trip") }).click();
      await page.getByRole("button", { name: copy.restore, exact: true }).click();
      expect(state.conversations.find((c) => c.id === "trip").archivedAt).toBeNull();
      await page
        .getByRole("button", { name: /Zurück zu den Chats|Back to chats/ })
        .click();
      await page.getByRole("button", { name: copy.actions("Summer trip") }).click();
      await page.getByRole("button", { name: copy.delete, exact: true }).click();
      await expect(page.getByText(copy.deleteBody)).toBeVisible();
      await page.getByRole("button", { name: copy.deleteNow, exact: true }).click();
      await expect(row(page, "Summer trip")).toHaveCount(0);
      expect(state.conversations.map((c) => c.id)).toEqual(["main"]);
      // The main chat is renamed only: it stays where reminders deliver.
      await page.getByRole("button", { name: copy.actions("Dinner plans") }).click();
      await expect(page.getByRole("button", { name: copy.archive })).toHaveCount(0);
      await expect(page.getByRole("button", { name: copy.delete })).toHaveCount(0);
    });

    test("archived chats are read-only", async ({ page }) => {
      const state = await setup(page, language);
      state.conversations.push({
        id: "old",
        assistantId: "home",
        title: "Old",
        archivedAt: "2026-10-01T00:00:00.000Z",
      });
      state.messages.old = [{ id: "o1", role: "assistant", text: "From before." }];
      await page.goto(baseURL + "/agents/home/chats/old");
      await expect(page.getByText("From before.")).toBeVisible();
      await expect(page.getByText(copy.readOnly)).toBeVisible();
      await expect(page.getByLabel(copy.message, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: copy.restore, exact: true }).click();
      await expect(page.getByLabel(copy.message, { exact: true })).toBeVisible();
      // A link to a deleted chat says so and leads to the main chat.
      await page.goto(baseURL + "/agents/home/chats/gone");
      await expect(page.getByText(copy.deleted)).toBeVisible();
      await page.getByRole("button", { name: copy.toMain }).click();
      await expect(page).toHaveURL(/\/agents\/home\/chats\/main$/);
    });

    test("offline shows the last known window of the opened chat", async ({
      page,
      context,
    }) => {
      await setup(page, language);
      await page.goto(baseURL + "/agents/home/chats/main");
      await expect(page.getByText("Dinner is planned.")).toBeVisible();
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(page.getByText("Dinner is planned.")).toBeVisible();
      await expect(page.getByText(copy.offline).first()).toBeVisible();
      await context.setOffline(false);
    });
  });
