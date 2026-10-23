import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { userAppFixture } from "../helpers/user-app-fixture.js";

// A very long chat's hint (AGENTPIER-186): Summarise now has OpenClaw summarise the
// history in the chat's own session, Hide puts the hint away; on a phone, in German
// and English (server/features/assistants/long-chats.js).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = {
  en: {
    hint: /This chat is long\./,
    summarise: "Summarise now",
    hide: "Hide",
    summarising:
      "Summarising the conversation so far — this can take a few minutes for long chats.",
    note: "Earlier messages were summarised (about 150k → 9k tokens).",
    nothing: "The history cannot be summarised any further right now.",
    interrupted:
      "The summary stopped because the agent runtime stopped or restarted. The chat is ready again.",
    saving: "Saving memories before the summary …",
    notSaved: "No memories were saved before the summary.",
    busy: "The summary could not start because the agent was busy. The chat is ready again.",
  },
  de: {
    hint: /Dieser Chat ist lang\./,
    summarise: "Jetzt zusammenfassen",
    hide: "Ausblenden",
    summarising:
      "Fasst den bisherigen Verlauf zusammen – bei langen Chats kann das ein paar Minuten dauern.",
    note: "Ältere Nachrichten wurden zusammengefasst (etwa 150k → 9k Tokens).",
    nothing: "Der Verlauf lässt sich gerade nicht weiter zusammenfassen.",
    interrupted:
      "Die Zusammenfassung wurde abgebrochen, weil die Agent-Laufzeit beendet oder neu gestartet wurde. Der Chat ist wieder bereit.",
    saving: "Speichert Erinnerungen vor der Zusammenfassung …",
    notSaved: "Vor der Zusammenfassung wurden keine Erinnerungen gespeichert.",
    busy: "Die Zusammenfassung konnte nicht starten, weil der Agent beschäftigt war. Der Chat ist wieder bereit.",
  },
};

const retry = { en: "Try again", de: "Erneut versuchen" };
const earlier = [
  { id: "u0", role: "user", text: "Plan three dinners.", timestamp: 1, requestId: "q0" },
  { id: "a0", role: "assistant", text: "Here they are.", timestamp: 2, runId: "t0" },
];
const done = { id: "q0", state: "completed", text: earlier[0].text };
const longHistory = {
  messages: earlier,
  requests: [{ ...done, attempt: { id: "t0", state: "completed" } }],
  stale: false,
  longChat: true,
};
const note = {
  id: "compaction:c1",
  role: "event",
  event: "compaction",
  tokensBefore: 150000,
  tokensAfter: 9000,
  timestamp: 3,
  runId: null,
};
const hint = (page) => page.locator(".assistant-long-chat");
const synced = (page, id) =>
  page.waitForFunction((id) => window.agentFeed?.synced(id), id);
const noSideScroll = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test("Summarise now shows the summary running, then the hint is gone", async ({
      page,
    }) => {
      const state = await chatFixture(page, { language, history: longHistory });
      let release;
      const compacts = [];
      await page.route("**/api/assistant-conversations/dinner/compact", async (route) => {
        compacts.push(route.request().method());
        state.history = { ...longHistory, compacting: true };
        await page.evaluate(() => window.agentFeed.push("dinner"));
        await new Promise((resolve) => (release = resolve));
        // The fresh size is small again: no hint, and the summary's note.
        state.history = {
          ...longHistory,
          longChat: undefined,
          messages: [...earlier, note],
        };
        await route.fulfill({ json: { compacted: true } });
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await synced(page, "dinner");
      await expect(hint(page)).toContainText(copy.hint);
      await noSideScroll(page);
      await hint(page).getByRole("button", { name: copy.summarise }).dblclick();
      const status = page.locator(".assistant-run-state");
      await expect(status).toHaveText(copy.summarising);
      await expect(hint(page)).toHaveCount(0);
      release();
      await expect(page.getByText(copy.note)).toBeVisible();
      await expect(status).not.toHaveText(copy.summarising);
      await expect(hint(page)).toHaveCount(0);
      expect(compacts).toEqual(["POST"]);
    });

    test("Summarise now saves memories first, and says when none were saved", async ({
      page,
    }) => {
      const state = await chatFixture(page, { language, history: longHistory });
      const push = async (history) => {
        state.history = history;
        await page.evaluate(() => window.agentFeed.push("dinner"));
      };
      const compacts = [];
      await page.route("**/api/assistant-conversations/dinner/compact", async (route) => {
        compacts.push(route.request().method());
        // The memory step runs first (server long-chats.js); the request answers at
        // once that the summary runs.
        state.history = { ...longHistory, compacting: "memory" };
        await route.fulfill({ json: { compacted: false, running: true } });
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await synced(page, "dinner");
      await hint(page).getByRole("button", { name: copy.summarise }).click();
      const status = page.locator(".assistant-run-state");
      await expect(status).toHaveText(copy.saving);
      await expect(hint(page)).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await noSideScroll(page);
      if (language === "en" && process.env.MEMORY_STEP_SCREENSHOT)
        await page.screenshot({ path: process.env.MEMORY_STEP_SCREENSHOT });
      await push({ ...longHistory, compacting: true });
      await expect(status).toHaveText(copy.summarising);
      await push({
        ...longHistory,
        longChat: undefined,
        messages: [...earlier, note],
        memoryNotSaved: true,
      });
      await expect(page.getByText(copy.note)).toBeVisible();
      const outcome = page.locator(".assistant-compact-outcome");
      await expect(outcome).toHaveText(copy.notSaved);
      await expect(status).not.toHaveText(copy.summarising);
      // A summary refused after the step says why, next to the note.
      await push({ ...longHistory, compactOutcome: "busy", memoryNotSaved: true });
      await expect(outcome).toHaveText(`${copy.busy} ${copy.notSaved}`);
      await noSideScroll(page);
      expect(compacts).toEqual(["POST"]);
    });

    test("a memory step of unknown or failed outcome offers no Retry", async ({
      page,
    }) => {
      const step = (attempt) => ({
        ...longHistory,
        requests: [
          ...longHistory.requests,
          { id: "q1", state: "accepted", internal: "memory-step", attempt },
        ],
      });
      const state = await chatFixture(page, {
        language,
        history: {
          ...step({ id: "t1", state: "uncertain" }),
          compacting: "memory",
        },
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await synced(page, "dinner");
      // The step's run lost its acknowledgement: memories are still being saved.
      const status = page.locator(".assistant-run-state");
      await expect(status).toHaveText(copy.saving);
      // Its run failed: the summary follows, and no Retry sends an owner turn.
      state.history = {
        ...step({ id: "t1", state: "failed", failure: "timeout" }),
        compacting: true,
      };
      await page.evaluate(() => window.agentFeed.push("dinner"));
      await expect(status).toHaveText(copy.summarising);
      await expect(page.locator(".assistant-run-failure")).toBeVisible();
      await expect(page.getByRole("button", { name: retry[language] })).toHaveCount(0);
      await noSideScroll(page);
    });

    test("a summary that outlives its request keeps running, then says how it ended", async ({
      page,
    }) => {
      const state = await chatFixture(page, { language, history: longHistory });
      await page.route("**/api/assistant-conversations/dinner/compact", async (route) => {
        state.history = { ...longHistory, compacting: true };
        // The request's own timeout passed; the Gateway still summarises.
        await route.fulfill({ json: { compacted: false, running: true } });
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await synced(page, "dinner");
      await hint(page).getByRole("button", { name: copy.summarise }).click();
      const status = page.locator(".assistant-run-state");
      await expect(status).toHaveText(copy.summarising);
      await expect(page.getByRole("alert")).toHaveCount(0);
      // The runtime restarted meanwhile: the chat is free again and says why.
      state.history = { ...longHistory, compactOutcome: "interrupted" };
      await page.evaluate(() => window.agentFeed.push("dinner"));
      await expect(page.locator(".assistant-compact-outcome")).toHaveText(
        copy.interrupted,
      );
      await expect(status).not.toHaveText(copy.summarising);
      await noSideScroll(page);
    });

    test("Hide puts the hint away, and a refusal shows why", async ({ page }) => {
      const state = await chatFixture(page, { language, history: longHistory });
      const dismissed = [];
      await page.route("**/api/assistant-conversations/dinner/compact", (route) =>
        route.fulfill({
          status: 409,
          json: { code: "CHAT_COMPACT_NOTHING", error: copy.nothing },
        }),
      );
      await page.route(
        "**/api/assistant-conversations/dinner/long-chat-dismissal",
        async (route) => {
          dismissed.push(route.request().method());
          state.history = { ...longHistory, longChat: undefined };
          await route.fulfill({ json: { dismissed: true } });
        },
      );
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await synced(page, "dinner");
      await hint(page).getByRole("button", { name: copy.summarise }).click();
      await expect(page.getByRole("alert")).toContainText(copy.nothing);
      await expect(hint(page)).toBeVisible();
      await hint(page).getByRole("button", { name: copy.hide }).click();
      await expect(hint(page)).toHaveCount(0);
      expect(dismissed).toEqual(["POST"]);
    });

    test("a user summarises and hides the hint in her own chat", async ({ page }) => {
      const state = await userAppFixture(page, {
        language,
        messages: { main: earlier },
        longChat: { main: true },
      });
      await page.goto(baseURL + "/agents/lotta/chats/main");
      await synced(page, "main");
      await expect(hint(page)).toContainText(copy.hint);
      await noSideScroll(page);
      await hint(page).getByRole("button", { name: copy.summarise }).click();
      await expect(hint(page)).toHaveCount(0);
      state.longChat = { main: true };
      await page.evaluate(() => window.agentFeed.push("main"));
      await hint(page).getByRole("button", { name: copy.hide }).click();
      await expect(hint(page)).toHaveCount(0);
      expect(state.longChatCalls).toEqual(["main/compact", "main/long-chat-dismissal"]);
      expect(state.foreign).toEqual([]);
    });

    for (const [name, conversation] of [
      ["an archived chat", { archivedAt: "2026-10-21T08:00:00Z" }],
      ["a user's chat the owner reads", { userId: "anna" }],
    ])
      test(`${name} offers no action`, async ({ page }) => {
        await chatFixture(page, {
          language,
          conversations: [{ id: "dinner", assistantId: "home", ...conversation }],
          history: longHistory,
        });
        await page.goto(baseURL + "/agents/home/chats/dinner");
        await synced(page, "dinner");
        await expect(hint(page)).toBeVisible();
        await expect(hint(page).getByRole("button")).toHaveCount(0);
      });
  });
