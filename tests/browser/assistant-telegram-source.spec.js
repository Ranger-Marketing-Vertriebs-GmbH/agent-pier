import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// Today at 11:41 in the browser's (the host's) time zone.
const at = new Date();
at.setHours(11, 41, 0, 0);
const timestamp = at.getTime();
const telegram = { source: "telegram", sender: { kind: "owner" }, timestamp };
const messages = [
  { id: "web", role: "user", text: "Plan dinner for Friday.", timestamp },
  { id: "r1", role: "assistant", text: "Pasta it is.", timestamp },
  {
    id: "own",
    role: "user",
    text: "Add a salad, please.",
    ...telegram,
  },
  { id: "r2", role: "assistant", text: "Salad added.", timestamp },
];

const copy = {
  en: { via: "via Telegram", you: "You" },
  de: { via: "über Telegram", you: "Du" },
};

async function setup(page, language) {
  await fixture(page);
  await page.addInitScript((language) => {
    localStorage.setItem("agentpier-language", language);
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
    name: "Home assistant",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 1,
    effectiveRevision: 1,
  };
  const state = { messages: [...messages], requests: [] };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(p)
    )
      return route.fallback();
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants: [assistant],
        conversations: [{ id: "dinner", assistantId: "home" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        members: [],
        activity: {},
      };
    else if (p === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages"))
      body = { messages: state.messages, requests: state.requests, stale: false };
    else if (p === "/api/assistants/home") body = assistant;
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.locator(".assistant-message")).toHaveCount(messages.length);
  return state;
}

const bubble = (page, text) =>
  page.locator(".assistant-message").filter({ hasText: text });
const turn = (page, text) => page.locator(".assistant-turn").filter({ hasText: text });

for (const language of ["en", "de"]) {
  test(`Telegram messages are marked in the agent chat (${language})`, async ({
    page,
  }) => {
    const words = copy[language];
    await setup(page, language);
    const time = await page.evaluate(
      ([value, locale]) =>
        new Date(value).toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      [timestamp, language === "de" ? "de-DE" : "en-US"],
    );
    // The owner's own Telegram message: the owner's bubble plus a quiet meta line.
    const own = turn(page, "Add a salad, please.");
    // Screen readers hear the meta line as the message's description, without the dot.
    const meta = own.locator(".assistant-message-meta");
    await expect(meta.locator('[aria-hidden="true"]')).toHaveText(
      `${words.via} · ${time}`,
    );
    await expect(meta.locator('[aria-hidden="true"]')).toBeVisible();
    await expect(own.locator(".assistant-message")).toHaveAttribute(
      "aria-describedby",
      (await meta.getAttribute("id")) || "missing",
    );
    await expect(own.locator(".assistant-message")).toHaveAccessibleDescription(
      `${words.via}, ${time}`,
    );
    await expect(own.locator(".assistant-message > strong")).toHaveText(words.you);
    await expect(own.locator(".assistant-message > strong")).toHaveClass(/sr-only/);
    // The bubble itself stays the owner's, exactly like a web message.
    const background = (locator) =>
      locator.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await background(own.locator(".assistant-message"))).toBe(
      await background(bubble(page, "Plan dinner for Friday.")),
    );
    // Web messages and agent replies carry no source.
    await expect(turn(page, "Plan dinner for Friday.")).toHaveCount(0);
    await expect(turn(page, "Pasta it is.")).toHaveCount(0);
    await expect(page.locator(".assistant-message-meta")).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test("a Telegram message arriving in an open chat is marked at once", async ({
  page,
}) => {
  const state = await setup(page, "en");
  state.requests = [
    {
      id: "request-1",
      clientRequestId: "telegram:input-1",
      text: "One more thing: no onions.",
      state: "pending",
      createdAt: new Date(timestamp).toISOString(),
      attempt: { id: "attempt-1", state: "running", reviewedAt: null },
      source: "telegram",
      sender: { kind: "owner" },
    },
  ];
  await page.evaluate(() =>
    window.assistantTestStream.onmessage({ data: JSON.stringify({ type: "change" }) }),
  );
  const live = turn(page, "One more thing: no onions.");
  await expect(live.locator(".assistant-message-meta")).toContainText("via Telegram");
  // Once OpenClaw stored the turn (trailing whitespace trimmed), it shows only once.
  state.requests[0].text = "One more thing: no onions.\n";
  state.messages = [
    ...state.messages,
    {
      id: "stored",
      role: "user",
      text: "One more thing: no onions.",
      ...telegram,
    },
  ];
  await page.evaluate(() =>
    window.assistantTestStream.onmessage({ data: JSON.stringify({ type: "change" }) }),
  );
  await expect(bubble(page, "One more thing: no onions.")).toHaveCount(1);
  await expect(page.locator(".assistant-message-meta")).toHaveCount(2);
});

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch: name === "mobile", isMobile: name === "mobile" });
    test(`Telegram sources screenshot (${name})`, async ({ page }) => {
      const directory = process.env.TELEGRAM_SOURCE_SHOTS;
      test.skip(!directory, "Screenshots are taken on request.");
      await setup(page, "en");
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: `${directory}/telegram-source-${name}-en.png` });
    });
  });
}
