import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// An agent the agent service could not start (AGENTPIER-238): its chat says so and
// offers the restart, its refused turn says the message was not delivered, and the
// sidebar marks it, on a phone in English and German.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = {
  en: {
    banner:
      "This agent couldn't start in the agent service. Restart the agent service to bring it back.",
    restart: "Restart agent service",
    refused: /so the message was not delivered\./,
    status: "Couldn't start",
  },
  de: {
    banner:
      "Dieser Agent konnte im Agentendienst nicht starten. Starte den Agentendienst neu, um ihn wiederherzustellen.",
    restart: "Agentendienst neu starten",
    refused: /die Nachricht wurde nicht zugestellt\./,
    status: "Konnte nicht starten",
  },
};

for (const [language, copy] of Object.entries(languages))
  test(`${language}: a degraded agent's chat explains it and offers the restart`, async ({
    page,
  }) => {
    const attempt = { id: "a-1", state: "failed", failure: "degraded" };
    const state = await chatFixture(page, {
      language,
      assistants: [chatAssistant({ degraded: true })],
      conversations: [
        { id: "dinner", assistantId: "home", diagnostic: "AGENT_DEGRADED" },
      ],
      activity: {
        home: {
          state: "attention",
          reason: "degraded",
          label: "status.degraded",
          pendingApprovals: 0,
          team: null,
        },
      },
      history: {
        messages: [{ id: "q", role: "user", text: "Plan dinner.", requestId: "q-1" }],
        requests: [{ id: "q-1", state: "failed", text: "Plan dinner.", attempt }],
        stale: false,
      },
    });
    await page.goto(baseURL + "/agents/home/chats/dinner");
    const banner = page.locator(".agent-chat-banner");
    await expect(banner).toContainText(copy.banner);
    await expect(page.locator(".assistant-run-failure")).toContainText(copy.refused);
    await expect(page.locator(".assistant-header-label")).toHaveText(copy.status);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await banner.getByRole("button", { name: copy.restart }).click();
    await expect.poll(() => state.calls).toContain("/api/assistant-runtime/restart");
  });
