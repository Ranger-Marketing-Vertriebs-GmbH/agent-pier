import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = {
    channel: null,
    speech: { revision: 0, model: "nova-3", language: "auto", hasSecret: false },
    created: null,
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname,
      m = route.request().method();
    let body;
    if (p === "/api/assistants")
      body = {
        assistants: [
          {
            id: "home",
            name: "Home",
            instructions: "Plan meals",
            revision: 1,
            effectiveRevision: 1,
            model: { connectionId: "router", modelId: "model" },
          },
        ],
        conversations: [],
        models: [{ id: "router", name: "Router", available: true }],
      };
    else if (p === "/api/assistant-runtime") body = { availability: "ready" };
    else if (p === "/api/assistant-speech") {
      if (m === "PUT") {
        const input = route.request().postDataJSON();
        state.speech = {
          ...state.speech,
          model: input.model || state.speech.model,
          language: input.language || state.speech.language,
          hasSecret: !input.removeApiKey,
          revision: state.speech.revision + 1,
        };
      }
      body = state.speech;
    } else if (p === "/api/assistant-channels") {
      if (m === "POST") {
        state.created = route.request().postDataJSON();
        state.channel = {
          id: "telegram",
          assistantId: "home",
          conversationId: "chat",
          username: "fixture_bot",
          enabled: false,
          hasSecret: true,
          revision: 1,
          inputs: [],
        };
        body = state.channel;
      } else body = { channels: state.channel ? [state.channel] : [] };
    } else if (p.endsWith("/pair")) {
      state.paired = route.request().postDataJSON();
      body = {
        code: "synthetic-pair-code",
        url: "https://t.me/fixture_bot?start=synthetic-pair-code",
        channel: state.channel,
      };
    } else if (p.endsWith("/review")) {
      state.channel.inputs[0].state = "reviewed";
      body = state.channel.inputs;
    } else if (p === "/api/assistant-channels/telegram") {
      if (m === "DELETE")
        state.channel = {
          ...state.channel,
          enabled: false,
          hasSecret: false,
          revision: 2,
        };
      else {
        state.patched = route.request().postDataJSON();
        state.channel = {
          ...state.channel,
          ...state.patched,
          revision: 2,
        };
      }
      body = state.channel;
    } else return route.fallback();
    return route.fulfill({ json: body });
  });
  return state;
}
test("Deepgram settings save a write-only credential and allow removal", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const panel = page.getByRole("region", { name: "Speech recognition" });
  await panel.getByLabel("Deepgram API key").fill("private-fixture-key");
  await panel.getByLabel("Recognition language").selectOption("de");
  await panel.getByRole("button", { name: "Save speech settings" }).click();
  await expect(panel.getByText("Key saved", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Deepgram API key")).toHaveValue("");
  await panel.getByRole("button", { name: "Remove speech key" }).click();
  await expect(panel.getByText("No key configured", { exact: true })).toBeVisible();
});
test("Telegram pairing and unknown delivery recovery remain visible in mobile agent settings", async ({
  page,
}) => {
  const state = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/agents/home/settings");
  const panel = page.getByRole("region", { name: "Telegram" });
  await panel.getByLabel("Telegram bot token").fill("123456:synthetic-token-for-test");
  await panel.getByRole("button", { name: "Connect Telegram" }).click();
  await expect(panel.getByRole("link", { name: "Pair my private chat" })).toHaveAttribute(
    "href",
    /t.me\/fixture_bot\?start=/,
  );
  expect(state.created.assistantId).toBe("home");
  state.channel = {
    ...state.channel,
    enabled: true,
    chatId: "42",
    userId: "42",
    inputs: [
      {
        id: "inbound",
        kind: "voice",
        text: "Dinner ideas",
        state: "delivery_uncertain",
        diagnostic: "DELIVERY_UNCERTAIN",
      },
    ],
  };
  await expect(panel.getByText("Dinner ideas")).toBeVisible();
  await expect(
    panel.getByText("Delivery outcome unknown", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.screenshot({
    path: ".cache/assistant-telegram-mobile-en.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await panel.getByRole("button", { name: "Acknowledge without resending" }).click();
  await expect(panel.getByText("Reviewed", { exact: true })).toBeVisible();
});

test("the oldest blocked input remains actionable behind twenty newer inputs", async ({
  page,
}) => {
  const state = await setup(page);
  state.channel = {
    id: "telegram",
    assistantId: "home",
    conversationId: "chat",
    username: "fixture_bot",
    enabled: true,
    hasSecret: true,
    revision: 1,
    chatId: "42",
    inputs: [
      {
        id: "blocked",
        kind: "voice",
        state: "transcription_failed",
        text: "Oldest blocked input",
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `queued-${i}`,
        kind: "text",
        state: "queued",
        text: `Queued ${i}`,
      })),
    ],
  };
  await page.goto(baseURL + "/agents/home/settings");
  const panel = page.getByRole("region", { name: "Telegram" });
  await expect(panel.getByText("Oldest blocked input")).toBeVisible();
  await panel.getByRole("button", { name: "Acknowledge without resending" }).click();
  await expect.poll(() => state.channel.inputs[0].state).toBe("reviewed");
});

test("an answer without text and a full queue are explained and reviewable", async ({
  page,
}) => {
  const state = await setup(page);
  state.channel = {
    id: "telegram",
    assistantId: "home",
    conversationId: "chat",
    username: "fixture_bot",
    enabled: true,
    hasSecret: true,
    revision: 1,
    chatId: "42",
    diagnostic: "CHANNEL_QUEUE_FULL",
    inputs: [
      {
        id: "silent",
        kind: "text",
        state: "reply_unavailable",
        diagnostic: "REPLY_WITHOUT_TEXT",
        needsReview: true,
        text: "Check the calendar",
      },
    ],
  };
  await page.goto(baseURL + "/agents/home/settings");
  const panel = page.getByRole("region", { name: "Telegram" });
  await expect(
    panel.getByText("The Telegram queue is full.", { exact: false }),
  ).toBeVisible();
  await expect(panel.getByText("Answer without text", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("finished without a text answer", { exact: false }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Acknowledge without resending" }).click();
  await expect.poll(() => state.channel.inputs[0].state).toBe("reviewed");
});

test("mobile recovery keeps uncertain team notifications separate from original messages", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/assistant-feature", fulfillEnabledAssistantFeature);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/api/assistants", (route) =>
    route.fulfill({
      json: {
        assistants: [
          {
            id: "home",
            name: "Home",
            instructions: "",
            model: { connectionId: "router", modelId: "fixture" },
            revision: 1,
            effectiveRevision: 1,
          },
        ],
        models: [],
        conversations: [],
      },
    }),
  );
  await page.route("**/api/assistant-channels", (route) =>
    route.fulfill({
      json: {
        channels: [
          {
            id: "channel",
            assistantId: "home",
            username: "fixture_bot",
            hasSecret: true,
            enabled: false,
            chatId: "42",
            revision: 1,
            inputs: [],
            notifications: [
              {
                id: "late-result",
                notification: true,
                kind: "team-result",
                text: "Team finished",
                state: "delivery_uncertain",
                diagnostic: "DELIVERY_UNCERTAIN",
              },
            ],
          },
        ],
      },
    }),
  );
  let reviewed = false;
  await page.route(
    "**/api/assistant-channels/channel/notifications/late-result/review",
    (route) => {
      reviewed = true;
      return route.fulfill({ json: [] });
    },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/agents/home/settings");
  await expect(page.getByText("Team notification", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Acknowledge without resending", exact: true })
    .click();
  await expect.poll(() => reviewed).toBe(true);
});

test("Telegram links use the browser address, which the owner can change", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  const panel = page.getByRole("region", { name: "Telegram" });
  await panel.getByLabel("Telegram bot token").fill("123456:synthetic-token-for-test");
  await panel.getByRole("button", { name: "Connect Telegram" }).click();
  await expect(panel.getByRole("link", { name: "Pair my private chat" })).toBeVisible();
  const origin = new URL(baseURL).origin;
  expect(state.created.appUrl).toBe(origin);
  expect(state.paired.appUrl).toBe(origin);
  expect(state.created.language).toBe("en");
  expect(state.paired.language).toBe("en");
  state.channel = {
    ...state.channel,
    appUrl: origin,
    enabled: true,
    chatId: "42",
    ignoredMessages: { private: 2, group: 1 },
    inputs: [
      {
        id: "voice",
        kind: "voice",
        state: "transcription_failed",
        diagnostic: "TRANSCRIPTION_QUOTA",
        diagnosticDetail: '{"err_msg":"Insufficient credits"}',
      },
    ],
  };
  await expect(
    panel.getByText("Ignored messages: 2 from other private chats, 1 from groups."),
  ).toBeVisible();
  await expect(panel.getByText(/Deepgram balance or quota is exhausted/)).toBeVisible();
  await expect(panel.getByText('{"err_msg":"Insufficient credits"}')).toBeVisible();
  const address = panel.getByLabel("AgentPier address for links");
  await expect(address).toHaveValue(origin);
  await address.fill("https://pier.example");
  await panel.getByRole("button", { name: "Save address" }).click();
  await expect.poll(() => state.patched?.appUrl).toBe("https://pier.example");
  await expect(address).toHaveValue("https://pier.example");
  await panel.getByLabel("Language of Telegram notices").selectOption("de");
  await expect.poll(() => state.patched?.language).toBe("de");
  expect(state.patched.appUrl).toBeUndefined();
});
