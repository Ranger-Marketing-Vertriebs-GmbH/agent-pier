import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

// An open chat's pending actions arrive on its feed (the history's `actions`); the
// chat reads `GET /assistants/:id/actions` only while no feed carries them.
const ssh = (extra = {}) => ({
  id: "ssh-1",
  revision: 1,
  assistantId: "home",
  state: "awaiting_approval",
  createdAt: "2026-10-16T10:00:00.000Z",
  expiresAt: "2026-10-16T10:10:00.000Z",
  payload: {
    action: "ssh",
    accessId: "11111111-1111-4111-8111-111111111111",
    hostName: "opnsense",
    host: "opnsense.invalid",
    port: 22,
    username: "root",
    hostFingerprint: "SHA256:opnsense",
    command: "uptime",
    timeoutSeconds: 30,
    originClass: "owner",
  },
  ...extra,
});
const history = (actions) => ({
  messages: [{ id: "answer", role: "assistant", text: "We can plan dinner together." }],
  requests: [],
  stale: false,
  actions,
});
const card = (page) => page.getByRole("article", { name: "SSH command" });

for (const [name, size, touch] of [
  ["desktop", { width: 1440, height: 1000 }, false],
  ["phone", { width: 390, height: 844 }, true],
])
  test.describe(name, () => {
    test.use({ viewport: size, hasTouch: touch, isMobile: touch });

    test("an approval card comes and goes with the feed, without reading the actions", async ({
      page,
    }) => {
      const state = await chatFixture(page, { history: history([]) });
      const reads = [];
      page.on("request", (request) => {
        if (
          request.method() === "GET" &&
          /\/api\/assistants\/home\/actions$/.test(request.url())
        )
          reads.push(request.url());
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await page.waitForFunction(() => window.agentFeed?.sockets.size === 1);
      await expect(page.getByText("We can plan dinner together.")).toBeVisible();
      // At most the start read, before the feed connected.
      const started = reads.length;
      expect(started).toBeLessThanOrEqual(1);
      state.history = history([ssh()]);
      await page.evaluate(() => window.agentFeed.push("dinner"));
      await expect(card(page)).toContainText("uptime");
      // Change events re-read the feed, never the actions.
      for (let i = 0; i < 5; i++) await emit(page, { type: "change" });
      await expect(card(page)).toBeVisible();
      await card(page).getByRole("button", { name: "Allow once on opnsense" }).click();
      // The decided card leaves at once and stays away until the feed says more.
      await expect(card(page)).toHaveCount(0);
      expect(state.calls).toContain("/api/assistant-actions/ssh-1/decision");
      state.history = history([]);
      await page.evaluate(() => window.agentFeed.push("dinner"));
      await expect(card(page)).toHaveCount(0);
      // A new request appears live as well.
      state.history = history([
        ssh({ id: "ssh-2", payload: { ...ssh().payload, command: "df -h" } }),
      ]);
      await page.evaluate(() => window.agentFeed.push("dinner"));
      await expect(card(page)).toContainText("df -h");
      expect(reads.length).toBe(started);
    });

    test("without the feed the chat reads the actions as before", async ({ page }) => {
      // An older server: the history carries no actions.
      const state = await chatFixture(page, {
        history: { ...history([]), actions: undefined },
        actions: [ssh()],
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(card(page)).toContainText("uptime");
      state.actions = [];
      await emit(page, { type: "change" });
      await expect(card(page)).toHaveCount(0);
    });
  });
