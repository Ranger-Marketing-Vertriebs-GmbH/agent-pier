import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { userAppFixture } from "../helpers/user-app-fixture.js";

// A running agent turn's live steps, a turn that hears nothing from the model and a
// very long chat (AGENTPIER-184), on a phone in German and English. The fake feed
// (agent-feed-fake.js) sends the `steps` frames the server derives from the
// Gateway's events (server/features/assistants/run-steps.js).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = {
  en: {
    running: "Command · Figurenreferenz ermitteln",
    steps: "2 steps",
    thought: "Thought about it",
    done: "Done",
    waiting: "Waiting for the model",
    stalled: "No answer from the model for 5 minutes.",
    stop: "Stop",
    retry: "Try again",
    continue: "Please continue where you stopped.",
    timedOut: /The model did not answer in time\./,
    longChat: /This chat is long\./,
    retrying: "The model did not answer, trying again (2 of 8)",
    approval: "Waiting for approval",
    compacting: "Summarising the chat",
    summarising:
      "Summarising the conversation so far — this can take a few minutes for long chats.",
  },
  de: {
    running: "Befehl · Figurenreferenz ermitteln",
    steps: "2 Schritte",
    thought: "Hat nachgedacht",
    done: "Erledigt",
    waiting: "Wartet auf das Modell",
    stalled: "Seit 5 Minuten keine Antwort vom Modell.",
    stop: "Stoppen",
    retry: "Erneut versuchen",
    continue: "Bitte mach dort weiter, wo du aufgehört hast.",
    timedOut: /Das Modell hat nicht rechtzeitig geantwortet\./,
    longChat: /Dieser Chat ist lang\./,
    retrying: "Das Modell hat nicht geantwortet, neuer Versuch (2 von 8)",
    approval: "Wartet auf Freigabe",
    compacting: "Fasst den Chat zusammen",
    summarising:
      "Fasst den bisherigen Verlauf zusammen – bei langen Chats kann das ein paar Minuten dauern.",
  },
};

const running = (attempt = { id: "a-1", runtimeRunId: "run-1", state: "running" }) => ({
  messages: [{ id: "q", role: "user", text: "Draw the family.", requestId: "q-1" }],
  requests: [{ id: "q-1", state: attempt.state, text: "Draw the family.", attempt }],
  stale: false,
});
const steps = (extra = {}) => ({
  type: "steps",
  runId: "run-1",
  steps: [
    { id: "thinking:0", kind: "thinking", state: "done" },
    {
      id: "tool:c1",
      kind: "tool",
      tool: "exec",
      label: "Figurenreferenz ermitteln",
      state: "running",
    },
  ],
  omitted: 0,
  phase: "tool",
  retry: null,
  quietMs: 0,
  ...extra,
});
const send = (page, id, frame) =>
  page.evaluate(([id, frame]) => window.agentFeed.send(id, frame), [id, frame]);
const synced = (page, id) =>
  page.waitForFunction((id) => window.agentFeed?.synced(id), id);
const noSideScroll = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test("the owner's chat shows the running turn's steps, collapsed", async ({
      page,
    }) => {
      await chatFixture(page, { language, history: running() });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await synced(page, "dinner");
      await send(page, "dinner", steps());
      const status = page.locator(".assistant-run-state");
      await expect(status).toHaveText(copy.running);
      const details = page.locator(".assistant-run-steps");
      await expect(details.locator("summary")).toHaveText(copy.steps);
      await expect(details.getByText(copy.thought)).toBeHidden();
      await details.locator("summary").click();
      await expect(details.getByText(copy.thought)).toBeVisible();
      await expect(details.locator("li").first()).toContainText(copy.done);
      // The tool ends; the turn waits for the model again, then retries.
      await send(page, "dinner", steps({ phase: "model" }));
      await expect(status).toHaveText(copy.waiting);
      await send(
        page,
        "dinner",
        steps({ phase: "retrying", retry: { attempt: 2, of: 8, reason: "timeout" } }),
      );
      await expect(status).toHaveText(copy.retrying);
      // An exec approval waits for a person; a compaction summarises the chat.
      await send(page, "dinner", steps({ phase: "approval" }));
      await expect(status).toHaveText(copy.approval);
      await send(page, "dinner", steps({ phase: "compacting" }));
      await expect(status).toHaveText(copy.compacting);
      await noSideScroll(page);
      await send(page, "dinner", { type: "steps-end", runId: "run-1" });
      await expect(details).toHaveCount(0);
    });

    test("a turn without an answer from the model offers Stop and Try again", async ({
      page,
    }) => {
      const state = await chatFixture(page, { language, history: running() });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await synced(page, "dinner");
      await send(page, "dinner", steps({ phase: "model", quietMs: 5 * 60000 }));
      const notice = page.locator(".assistant-run-stalled");
      await expect(notice).toContainText(copy.stalled);
      await expect(notice.getByRole("button", { name: copy.stop })).toBeVisible();
      await noSideScroll(page);
      // A running tool is never stalled, however long it runs.
      await send(page, "dinner", steps({ quietMs: 30 * 60000 }));
      await expect(notice).toHaveCount(0);
      await send(page, "dinner", steps({ phase: "model", quietMs: 5 * 60000 }));
      // Once stopped, the turn is cancelled and the agent is asked to go on.
      state.history = running({ id: "a-1", runtimeRunId: "run-1", state: "cancelled" });
      await notice.getByRole("button", { name: copy.retry }).click();
      await expect.poll(() => state.posted.map((p) => p.text)).toEqual([copy.continue]);
      expect(state.calls).toContain("/api/assistant-attempts/a-1/cancel");
    });

    test("Try again clicked twice while the turn stops sends one stop and one message", async ({
      page,
    }) => {
      const state = await chatFixture(page, { language, history: running() });
      await page.route("**/api/assistant-attempts/*/cancel", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.fallback();
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await synced(page, "dinner");
      await send(page, "dinner", steps({ phase: "model", quietMs: 5 * 60000 }));
      const notice = page.locator(".assistant-run-stalled");
      state.history = running({ id: "a-1", runtimeRunId: "run-1", state: "cancelled" });
      const retry = notice.getByRole("button", { name: copy.retry });
      await retry.dblclick();
      await expect(retry).toBeDisabled();
      await expect.poll(() => state.posted.map((p) => p.text)).toEqual([copy.continue]);
      await page.waitForTimeout(600);
      expect(state.posted).toHaveLength(1);
      expect(state.calls.filter((p) => p.endsWith("/cancel"))).toEqual([
        "/api/assistant-attempts/a-1/cancel",
      ]);
    });

    test("a timed-out turn says why, and a long chat says so", async ({ page }) => {
      const state = await chatFixture(page, {
        language,
        history: {
          ...running({ id: "a-1", state: "failed", failure: "timeout" }),
          longChat: true,
        },
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(page.locator(".assistant-run-failure")).toContainText(copy.timedOut);
      await expect(page.locator(".assistant-long-chat")).toHaveText(copy.longChat);
      await noSideScroll(page);
      await page
        .locator(".assistant-run-failure")
        .getByRole("button", { name: copy.retry })
        .click();
      await expect.poll(() => state.posted.map((p) => p.text)).toEqual([copy.continue]);
    });

    test("a user sees her own turn's steps in her app", async ({ page }) => {
      const state = await userAppFixture(page, {
        language,
        messages: { main: running().messages },
        requests: { main: running().requests },
      });
      await page.goto(baseURL + "/agents/lotta/chats/main");
      await synced(page, "main");
      await send(page, "main", steps());
      await expect(page.locator(".assistant-run-state")).toHaveText(copy.running);
      await send(page, "main", steps({ phase: "model", quietMs: 5 * 60000 }));
      await expect(page.locator(".assistant-run-stalled")).toContainText(copy.stalled);
      await noSideScroll(page);
      expect(state.foreign).toEqual([]);
    });

    test("a user's chat names a compaction and an approval", async ({ page }) => {
      const state = await userAppFixture(page, {
        language,
        messages: { main: running().messages },
        requests: { main: running().requests },
      });
      await page.goto(baseURL + "/agents/lotta/chats/main");
      await synced(page, "main");
      const status = page.locator(".assistant-run-state");
      await send(page, "main", steps({ phase: "approval" }));
      await expect(status).toHaveText(copy.approval);
      await send(page, "main", steps({ phase: "compacting" }));
      await expect(status).toHaveText(copy.compacting);
      // The chat's history says it summarises, as in the owner's chat.
      state.compacting = { main: true };
      await page.reload();
      await expect(status).toHaveText(copy.summarising);
      await noSideScroll(page);
    });

    test("Try again in a user's chat runs once while the turn stops", async ({
      page,
    }) => {
      const state = await userAppFixture(page, {
        language,
        messages: { main: running().messages },
        requests: { main: running().requests },
      });
      const cancels = [];
      await page.route("**/api/me/attempts/*/cancel", async (route) => {
        cancels.push(new URL(route.request().url()).pathname);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.fallback();
      });
      await page.goto(baseURL + "/agents/lotta/chats/main");
      await synced(page, "main");
      await send(page, "main", steps({ phase: "model", quietMs: 5 * 60000 }));
      state.requests.main = running({
        id: "a-1",
        runtimeRunId: "run-1",
        state: "cancelled",
      }).requests;
      const retry = page
        .locator(".assistant-run-stalled")
        .getByRole("button", { name: copy.retry });
      await retry.dblclick();
      await expect.poll(() => state.posted.map((p) => p.text)).toEqual([copy.continue]);
      await page.waitForTimeout(600);
      expect(state.posted).toHaveLength(1);
      expect(cancels).toEqual(["/api/me/attempts/a-1/cancel"]);
    });
  });
