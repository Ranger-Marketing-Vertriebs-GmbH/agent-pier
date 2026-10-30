import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// Talk mode (AGENTPIER-291) with the real capture path (a fake microphone feeds the
// audio worklet) and stand-ins for AgentPier's talk routes, dictation socket and the
// reply read aloud. No speech service is called.
test.use({
  launchOptions: async ({ browserName, launchOptions }, use) =>
    use(
      browserName === "chromium"
        ? {
            ...launchOptions,
            args: [
              ...(launchOptions.args || []),
              "--use-fake-device-for-media-stream",
              "--use-fake-ui-for-media-stream",
              "--autoplay-policy=no-user-gesture-required",
            ],
          }
        : launchOptions,
    ),
  permissions: ["microphone"],
});

// A short silent WAV: every browser decodes it, unlike a fake MP3.
function silentWav(ms = 250, rate = 8000) {
  const samples = (rate * ms) / 1000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

const available = { available: true, provider: "openai", maxMinutes: 30, session: null };

/**
 * The talk routes and the dictation socket. Each socket answers its first audio with
 * the next spoken sentence of `said`, marked as the end of an utterance; a reply,
 * when given, joins the chat history as the agent's answer to the posted turn.
 */
async function talk(page, state, { status = available, said = [], reply = null } = {}) {
  const talkState = { sockets: [], stops: 0, starts: 0, readings: [] };
  await page.route("**/api/assistant-talk", async (route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: status });
    if (method === "DELETE") {
      talkState.stops++;
      return route.fulfill({ json: { stopped: true } });
    }
    talkState.starts++;
    return route.fulfill({
      status: 201,
      json: {
        id: "talk-session-0001",
        conversationId: "dinner",
        startedAt: 0,
        expiresAt: 30 * 60 * 1000,
      },
    });
  });
  await page.route("**/api/assistant-conversations/dinner/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    state.posted.push(body);
    if (reply)
      state.history = {
        ...state.history,
        messages: [
          ...state.history.messages,
          { id: `turn-${state.posted.length}`, role: "user", text: body.text },
          { id: reply.id, role: "assistant", text: reply.text },
        ],
      };
    await route.fulfill({
      status: 202,
      json: { request: { id: "sent" }, attempt: { id: "sent", state: "accepted" } },
    });
  });
  await page.route("**/api/assistant-conversations/dinner/messages/*/speech", (route) => {
    talkState.readings.push({
      url: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    return route.fulfill({ body: silentWav(), contentType: "audio/mpeg" });
  });
  await page.routeWebSocket(/\/api\/dictation\/stream/, (ws) => {
    const socket = { url: ws.url(), frames: 0 };
    talkState.sockets.push(socket);
    const sentence = said[talkState.sockets.length - 1];
    ws.send(JSON.stringify({ type: "ready", maxSeconds: 300 }));
    ws.onMessage((message) => {
      if (typeof message === "string") return;
      socket.frames++;
      if (socket.frames !== 3 || !sentence) return;
      ws.send(JSON.stringify({ type: "transcript", final: false, text: "What should" }));
      ws.send(
        JSON.stringify({
          type: "transcript",
          final: true,
          text: sentence,
          speechFinal: true,
        }),
      );
    });
  });
  return talkState;
}

test("a spoken turn is sent, its reply read aloud, and talk mode listens again", async ({
  page,
}) => {
  const state = await chatFixture(page);
  const session = await talk(page, state, {
    said: ["What should we cook tonight?"],
    reply: {
      id: "pasta",
      text: "Pasta with `pesto`, see https://example.com/a/long/recipe",
    },
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const button = page.getByRole("button", { name: "Talk with the agent" });
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  const bar = page.getByRole("region", { name: "Talk mode" });
  await expect(page.getByRole("button", { name: "Stop talking" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The words go out as a normal chat turn and appear as the owner's message.
  await expect
    .poll(() => state.posted.map((p) => p.text))
    .toEqual(["What should we cook tonight?"]);
  expect(session.sockets[0].url).toContain("talk=talk-session-0001");
  await expect(page.getByText("What should we cook tonight?")).toBeVisible();
  // The reply is read by its message id, in the language of the page.
  await expect.poll(() => session.readings.length).toBe(1);
  expect(session.readings[0]).toEqual({
    url: "/api/assistant-conversations/dinner/messages/pasta/speech",
    body: { language: "en" },
  });
  // Once played, a new spoken turn opens.
  await expect.poll(() => session.sockets.length).toBe(2);
  await expect(bar.getByRole("status")).toHaveText("Listening");
  // Tapping the bar pauses and resumes.
  await bar.getByRole("button", { name: "Pause talking" }).click();
  await expect(bar.getByRole("status")).toHaveText("Paused");
  await expect(bar.getByText("Tap to resume")).toBeVisible();
  await bar.getByRole("button", { name: "Resume talking" }).click();
  await expect(bar.getByRole("status")).toHaveText("Listening");
  await expect.poll(() => session.sockets.length).toBe(3);
  await bar.getByRole("button", { name: "Stop" }).click();
  await expect(bar).toBeHidden();
  await expect.poll(() => session.stops).toBe(1);
  await expect(button).toHaveAttribute("aria-pressed", "false");
});

test("a hidden page ends talk mode", async ({ page }) => {
  const state = await chatFixture(page);
  const session = await talk(page, state);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await page.getByRole("button", { name: "Talk with the agent" }).click();
  const bar = page.getByRole("region", { name: "Talk mode" });
  await expect(bar.getByRole("status")).toHaveText("Listening");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(bar.getByRole("alert")).toHaveText(
    "Talk mode ended because the page was hidden.",
  );
  await expect.poll(() => session.stops).toBe(1);
});

test("German: the bar thinks while the agent works and stops on Beenden", async ({
  page,
}) => {
  const state = await chatFixture(page, { language: "de" });
  const session = await talk(page, state, { said: ["Was kochen wir heute?"] });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await page.getByRole("button", { name: "Mit dem Agenten sprechen" }).click();
  const bar = page.getByRole("region", { name: "Sprechmodus" });
  await expect.poll(() => state.posted.length).toBe(1);
  await expect(bar.getByRole("status")).toHaveText("Denkt nach");
  await bar.getByRole("button", { name: "Beenden" }).click();
  await expect(bar).toBeHidden();
  await expect.poll(() => session.stops).toBe(1);
  expect(session.readings).toHaveLength(0);
});

test("without a voice the Talk button explains why, on a phone too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await chatFixture(page);
  const session = await talk(page, state, {
    status: { available: false, reason: "voiceMissing", maxMinutes: 30, session: null },
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const button = page.getByRole("button", { name: "Talk unavailable" });
  await expect(button).toHaveAttribute("aria-disabled", "true");
  // aria-disabled: still focusable and pressable, to explain why.
  await button.click({ force: true });
  const bar = page.getByRole("region", { name: "Talk mode" });
  await expect(bar).toContainText("needs a voice that reads replies aloud");
  await expect(bar.getByRole("link", { name: "Open speech settings" })).toBeVisible();
  const box = await bar.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await bar.getByRole("button", { name: "Close" }).click();
  await expect(bar).toBeHidden();
  expect(session.starts).toBe(0);
});

test("on a phone the talk bar sits above the composer inside the screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await chatFixture(page);
  await talk(page, state);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const button = page.getByRole("button", { name: "Talk with the agent" });
  await expect(button).toBeVisible();
  await button.click();
  const bar = page.getByRole("region", { name: "Talk mode" });
  await expect(bar.getByRole("status")).toHaveText("Listening");
  const toggle = await bar.getByRole("button", { name: "Pause talking" }).boundingBox();
  expect(toggle.height).toBeGreaterThanOrEqual(44);
  const box = await bar.boundingBox();
  const composer = await page.locator(".assistant-composer").boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
