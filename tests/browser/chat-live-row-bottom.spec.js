import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";

// A live row (the streamed reply, "preparing Agent …") can appear or grow from a
// live-status frame alone, without a new transcript, and the composer can grow
// under a followed chat. The newest row must stay fully above the composer.
// Scroll anchoring is off: WebKit has none, and Chromium's would mask a miss.
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 700 },
];
const TURN = "5b0d3c1e-2a4f-4e8b-9c61-7d2e8f1a4b30";
// The transcript ends with the prompt, so the streamed reply shows.
const messages = Array.from({ length: 25 }, (_, index) => ({
  id: `m${index}`,
  role: index % 2 ? "assistant" : "user",
  text: `Message ${index}: ${"a sentence that fills the column ".repeat(3)}`,
}));

async function chatFixture(page) {
  const session = {
    id: "live-row-bottom",
    accountId: "fixture",
    tool: "claude",
    cwd: "/fixture",
    status: "running",
    name: "Live row",
    activity: { state: "idle", observedAt: new Date(1000).toISOString() },
  };
  const data = {
    availability: "ready",
    providerSessionId: "conversation",
    messages,
    tasks: [],
  };
  const sockets = new Set();
  await page.routeWebSocket("**/api/sessions/*/chat-stream", (socket) => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.send(JSON.stringify({ type: "snapshot", sequence: 1, snapshot: data }));
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let result = {};
    if (pathname === "/api/state")
      result = {
        sessions: [session],
        accounts: [],
        tools: [{ id: "claude", name: "claude", installed: true }],
        home: "/fixture",
      };
    if (pathname.endsWith("/chat")) result = data;
    await route.fulfill({ json: result });
  });
  await page.goto(`${baseURL}/sessions/live-row-bottom/chat`);
  await expect(page.getByText("Message 24:")).toBeVisible();
  await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
  return {
    frame(value) {
      for (const socket of sockets) socket.send(JSON.stringify(value));
    },
  };
}

/** The newest row's bottom against the visible end of the list and the composer. */
async function expectNewestRowVisible(page, row) {
  await expect
    .poll(async () =>
      page.evaluate((selector) => {
        const list = document.querySelector(".chat-messages");
        const last = document.querySelector(selector);
        const compose = document.querySelector(".chat-compose-area");
        if (!list || !last || !compose) return "missing";
        const bottom = last.getBoundingClientRect().bottom;
        const visibleEnd = Math.min(
          list.getBoundingClientRect().top + list.clientHeight,
          compose.getBoundingClientRect().top,
        );
        return Math.round(bottom - visibleEnd) <= 0 ? "visible" : bottom - visibleEnd;
      }, row),
    )
    .toBe("visible");
}

for (const viewport of viewports)
  test.describe(viewport.name, () => {
    test.use({
      locale: "en-GB",
      viewport: { width: viewport.width, height: viewport.height },
    });
    test("live rows stay above the composer as they and the composer grow", async ({
      page,
    }) => {
      const chat = await chatFixture(page);
      const status = (value) =>
        chat.frame({ type: "live-status", status: { at: Date.now(), ...value } });
      const run = `claude-mod-${TURN}-0-0`;
      status({ state: "working", tool: "Bash", tools: 1 });
      chat.frame({
        type: "stream",
        runId: run,
        from: 0,
        text: "Checking the files.",
        turn: TURN,
        order: 0,
      });
      const bubble = page.locator(".chat-message.assistant", {
        hasText: "Checking the files.",
      });
      await expect(bubble).toBeVisible();
      await expectNewestRowVisible(page, ".chat-message.assistant:last-of-type");
      // A status frame alone adds the preparing line below the reply.
      status({ state: "working", preparing: "Agent" });
      const preparing = page.locator(".chat-live-preparing");
      await expect(preparing).toHaveText("preparing Agent …");
      await expectNewestRowVisible(page, ".chat-live-preparing");
      // A long tool name wraps the line onto more rows.
      status({ state: "working", preparing: `mcp__${"long_tool_name_".repeat(8)}` });
      await expect(preparing).toContainText("long_tool_name_long_tool_name_");
      await expectNewestRowVisible(page, ".chat-live-preparing");
      // A multi-line draft grows the composer.
      const field = page.locator(".chat-composer textarea");
      await field.fill("First line\nSecond line\nThird line\nFourth line\nFifth line");
      await expectNewestRowVisible(page, ".chat-live-preparing");
    });
  });
