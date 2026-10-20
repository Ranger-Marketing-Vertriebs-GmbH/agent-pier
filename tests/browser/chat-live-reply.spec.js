import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

// The session chat's live reply: `stream` frames grow one assistant bubble, and the
// final message of the transcript sync replaces it without a duplicate.
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 700 },
];
const user = { id: "u1", role: "user", text: "Question" };

async function chatFixture(page, tool) {
  const session = {
    id: "live-reply",
    accountId: "fixture",
    tool,
    cwd: "/fixture",
    status: "running",
    name: "Live reply",
  };
  let data = {
    availability: "ready",
    providerSessionId: "thread",
    messages: [user],
    tasks: [],
  };
  const sockets = new Map();
  await page.routeWebSocket("**/api/sessions/*/chat-stream", (socket) => {
    sockets.set(socket, 1);
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
        tools: [{ id: tool, name: tool, installed: true }],
        home: "/fixture",
      };
    if (pathname.endsWith("/chat")) result = data;
    await route.fulfill({ json: result });
  });
  await page.goto(`${baseURL}/sessions/live-reply/chat`);
  await expect(page.getByText("Question", { exact: true })).toBeVisible();
  return {
    frame(value) {
      for (const socket of sockets.keys()) socket.send(JSON.stringify(value));
    },
    sync(messages) {
      data = { ...data, messages: [user, ...messages] };
      for (const [socket, sequence] of sockets) {
        sockets.set(socket, sequence + 1);
        socket.send(
          JSON.stringify({ type: "snapshot", sequence: sequence + 1, snapshot: data }),
        );
      }
    },
  };
}

for (const viewport of viewports)
  test.describe(viewport.name, () => {
    test.use({
      locale: "en-GB",
      viewport: { width: viewport.width, height: viewport.height },
    });
    test("a Codex reply grows live and gives way to its final message", async ({
      page,
    }) => {
      const chat = await chatFixture(page, "codex");
      const live = page.locator(".chat-message.streaming");
      chat.frame({
        type: "stream",
        runId: "item-1",
        from: 0,
        text: "Hel",
        thread: "thread",
      });
      await expect(live).toHaveCount(1);
      await expect(live).toContainText("Hel");
      await expect(live).toContainText("writing …");
      chat.frame({ type: "stream", runId: "item-1", from: 3, text: "lo **world**" });
      await expect(live.locator("strong")).toHaveText("world");
      await expect(live).toContainText("Hello world");
      // A sub-agent thread never joins the main conversation's bubble.
      chat.frame({
        type: "stream",
        runId: "sub",
        from: 0,
        text: "Child",
        thread: "child",
      });
      const box = await live.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      chat.sync([{ id: "item-1", role: "assistant", text: "Hello **world**!" }]);
      chat.frame({ type: "stream-end", runId: "item-1" });
      await expect(live).toHaveCount(0);
      await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
      await expect(page.locator(".chat-message.assistant")).toContainText("Hello world!");
      await expect(page.getByText("Child")).toHaveCount(0);
    });

    test("Claude drafts follow the turn's order and give way to the JSONL replies", async ({
      page,
    }) => {
      const chat = await chatFixture(page, "claude");
      const live = page.locator(".chat-message.streaming");
      const draft = (runId, order, text) =>
        chat.frame({ type: "stream", runId, from: 0, text, turn: "turn-1", order });
      draft("claude-a", 0, "Let me check.\n");
      await expect(live).toHaveText(/Let me check\./);
      // The first message reaches the transcript, a tool runs, the second streams.
      chat.sync([
        { id: "msg_01:0", role: "assistant", text: "Let me check." },
        {
          id: "toolu_1",
          role: "tool",
          toolName: "Bash",
          text: "ls",
          status: "completed",
        },
      ]);
      draft("claude-b", 1, "Found it:\n");
      await expect(live).toHaveCount(1);
      await expect(live).toContainText("Found it:");
      chat.frame({ type: "stream", runId: "claude-b", from: 10, text: "- one line\n" });
      await expect(live.locator("li")).toHaveText("one line");
      chat.sync([
        { id: "msg_01:0", role: "assistant", text: "Let me check." },
        {
          id: "toolu_1",
          role: "tool",
          toolName: "Bash",
          text: "ls",
          status: "completed",
        },
        { id: "msg_02:0", role: "assistant", text: "Found it:\n- one line" },
      ]);
      await expect(live).toHaveCount(0);
      await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
      await expect(page.getByText("Let me check.")).toHaveCount(1);
    });

    test("an OpenCode part streams and an ended run without history fades", async ({
      page,
    }) => {
      const chat = await chatFixture(page, "opencode");
      const live = page.locator(".chat-message.streaming");
      chat.frame({
        type: "stream",
        runId: "prt_1",
        from: 0,
        text: "Thinking aloud",
        turn: "msg_1",
      });
      await expect(live).toContainText("Thinking aloud");
      // The transcript does not have it yet: the ended bubble stays a moment.
      chat.frame({ type: "stream-end", runId: "prt_1" });
      await expect(live).toHaveCount(1);
      await expect(live).toHaveCount(0, { timeout: 8000 });
    });
  });
