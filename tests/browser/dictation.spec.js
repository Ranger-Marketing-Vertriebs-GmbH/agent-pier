import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

// A fake microphone feeds the real capture path (audio worklet → PCM frames):
// Chromium's through its switches, WebKit's mock capture device by default. A
// stand-in for AgentPier's dictation socket answers.
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
            ],
          }
        : launchOptions,
    ),
  permissions: ["microphone"],
});

async function dictation(page, status = { available: true, autoSend: false }) {
  const stream = { frames: 0, bytes: 0, stops: 0, sockets: 0 };
  await page.route("**/api/dictation", (route) => route.fulfill({ json: status }));
  await page.routeWebSocket("**/api/dictation/stream", (ws) => {
    stream.sockets++;
    ws.send(JSON.stringify({ type: "ready", maxSeconds: 300 }));
    ws.onMessage((message) => {
      if (typeof message !== "string") {
        stream.frames++;
        stream.bytes += message.length;
        if (stream.frames === 2)
          ws.send(JSON.stringify({ type: "transcript", final: false, text: "please" }));
        if (stream.frames === 4)
          ws.send(
            JSON.stringify({ type: "transcript", final: false, text: "please check" }),
          );
        return;
      }
      if (JSON.parse(message).type !== "stop") return;
      stream.stops++;
      ws.send(
        JSON.stringify({
          type: "transcript",
          final: true,
          text: "please check the tests.",
        }),
      );
      ws.send(JSON.stringify({ type: "ended", reason: "stopped" }));
      ws.close();
    });
  });
  return stream;
}

async function sessionChat(page) {
  const session = {
    id: "dictate",
    name: "Dictation",
    tool: "claude",
    accountId: "local-claude",
    cwd: "/home/test/agentpier",
    status: "running",
  };
  const data = { availability: "ready", providerSessionId: "native", messages: [] };
  await mockChatStream(page, () => data);
  const inputs = [];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/(?!dictation)/, async (route) => {
    const p = new URL(route.request().url()).pathname;
    let json = {};
    if (p === "/api/state")
      json = {
        tools: [{ id: "claude", name: "Claude Code", installed: true }],
        accounts: [{ id: "local-claude", name: "Claude", tool: "claude", kind: "local" }],
        sessions: [session],
        home: "/home/test",
        remoteUrl: null,
      };
    else if (p.endsWith("/chat")) json = data;
    else if (p.endsWith("/input")) {
      const body = route.request().postDataJSON();
      inputs.push(body.text);
      json = { deliveryId: body.deliveryId, status: "handed-off" };
    }
    await route.fulfill({ json });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", () => {});
  return inputs;
}

test("agent chat: tapping the microphone writes live text into the field", async ({
  page,
}) => {
  const state = await chatFixture(page);
  const stream = await dictation(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const field = page.locator("#assistant-message");
  await field.fill("Hi,");
  const mic = page.getByRole("button", { name: "Start dictation" });
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await mic.click();
  const stop = page.getByRole("button", { name: "Stop dictation" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status").filter({ hasText: "Recording" })).toHaveCount(1);
  await expect(field).toHaveValue("Hi, please check");
  await stop.click();
  await expect(field).toHaveValue("Hi, please check the tests.");
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();
  // The real worklet sent 100 ms frames of 16-bit PCM at 16 kHz.
  expect(stream.bytes % 3200).toBe(0);
  expect(stream.stops).toBe(1);
  // Without the send-directly setting, the owner sends.
  expect(state.posted).toHaveLength(0);
  await field.press("Enter");
  await expect.poll(() => state.posted.length).toBe(1);
  expect(state.posted[0].text).toBe("Hi, please check the tests.");
});

test("session chat: dictation fills AgentPier's composer and can send right away", async ({
  page,
}) => {
  const inputs = await sessionChat(page);
  const stream = await dictation(page, { available: true, autoSend: true });
  await page.goto(baseURL + "/sessions/dictate/chat");
  const field = page.getByRole("textbox", { name: "Message" });
  await expect(field).toBeVisible();
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(field).toHaveValue("please check");
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect.poll(() => inputs).toEqual(["please check the tests."]);
  expect(stream.sockets).toBe(1);
});

test("without a key the microphone explains itself and links to the setup", async ({
  page,
}) => {
  await chatFixture(page);
  await page.route("**/api/dictation", (route) =>
    route.fulfill({
      json: { available: false, reason: "notConfigured", autoSend: false },
    }),
  );
  let opened = 0;
  await page.routeWebSocket("**/api/dictation/stream", () => opened++);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const mic = page.getByRole("button", { name: "Voice input unavailable" });
  await expect(mic).toHaveAttribute("aria-disabled", "true");
  // aria-disabled: still focusable and pressable, to explain why.
  await mic.click({ force: true });
  await expect(page.getByText("Voice input needs a Deepgram key.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Set up speech recognition" }),
  ).toHaveAttribute("href", "/accounts?section=services&item=speech");
  await page.getByRole("button", { name: "Close hint" }).click();
  await expect(page.getByText("Voice input needs a Deepgram key.")).toBeHidden();
  expect(opened).toBe(0);
});

test("over plain HTTP from another host the microphone explains the secure context", async ({
  page,
}) => {
  await chatFixture(page);
  await dictation(page);
  await page.addInitScript(() =>
    Object.defineProperty(window, "isSecureContext", { value: false }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const mic = page.getByRole("button", { name: "Voice input unavailable" });
  const box = await mic.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  // aria-disabled: still focusable and pressable, to explain why.
  await mic.click({ force: true });
  await expect(page.getByText(/needs a secure connection/)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("on a phone the session chat's hint stays inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await sessionChat(page);
  await page.route("**/api/dictation", (route) =>
    route.fulfill({
      json: { available: false, reason: "notConfigured", autoSend: false },
    }),
  );
  await page.goto(baseURL + "/sessions/dictate/chat");
  const mic = page.getByRole("button", { name: "Voice input unavailable" });
  expect((await mic.boundingBox()).width).toBeGreaterThanOrEqual(44);
  await mic.click({ force: true });
  const hint = page.locator(".dictation-hint");
  await expect(hint).toContainText("Voice input needs a Deepgram key.");
  const box = await hint.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
