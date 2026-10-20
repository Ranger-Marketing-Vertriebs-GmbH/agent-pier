import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

// The Claude Code bridge mod: token-sized `stream` frames grow the live bubble, and
// `live-status` frames put Working, Thinking and the running tool in the chat header
// the moment the turn reports them, then Ready when it ends.
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 700 },
];
const TURN = "0c9e6a2f-7d41-4f4e-9a15-3f4f7c2b8d10";
const user = { id: "u1", role: "user", text: "Question" };

async function chatFixture(page) {
  const session = {
    id: "live-status",
    accountId: "fixture",
    tool: "claude",
    cwd: "/fixture",
    status: "running",
    name: "Live status",
    activity: { state: "idle", observedAt: new Date(1000).toISOString() },
  };
  let data = {
    availability: "ready",
    providerSessionId: "conversation",
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
        tools: [{ id: "claude", name: "claude", installed: true }],
        home: "/fixture",
      };
    if (pathname.endsWith("/chat")) result = data;
    await route.fulfill({ json: result });
  });
  await page.goto(`${baseURL}/sessions/live-status/chat`);
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
    test("a mod-reported turn streams tokens and shows what it is doing", async ({
      page,
    }) => {
      const chat = await chatFixture(page);
      const activity = page.locator(".chat-activity");
      const detail = page.locator(".chat-activity-detail");
      const live = page.locator(".chat-message.streaming");
      await expect(activity).toContainText("Ready");
      const status = (value) =>
        chat.frame({ type: "live-status", status: { at: Date.now(), ...value } });
      status({ state: "working", phase: "thinking" });
      await expect(activity).toContainText("Working");
      await expect(detail).toHaveText("Thinking");
      // Token-sized appends, as the mod sends them about every 100 ms.
      const run = `claude-mod-${TURN}-0-1`;
      let sent = "";
      for (const piece of ["Let", " me", " check", " the", " **files**", "."]) {
        chat.frame({
          type: "stream",
          runId: run,
          from: sent.length,
          text: piece,
          turn: TURN,
          order: 0,
        });
        sent += piece;
        if (sent === "Let me") await expect(live).toContainText("Let me");
      }
      await expect(live.locator("strong")).toHaveText("files");
      status({ state: "working", tool: "Bash", tools: 1 });
      await expect(detail).toHaveText("Running Bash");
      status({ state: "working", tool: "mcp__github__search_repositories", tools: 1 });
      await expect(detail).toHaveText("Running github__search_repositories");
      for (const box of [await activity.boundingBox(), await detail.boundingBox()])
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      chat.sync([
        { id: "msg_01:1", role: "assistant", text: "Let me check the **files**." },
      ]);
      chat.frame({ type: "stream-end", runId: run });
      status({ state: "idle", agents: 1 });
      await expect(live).toHaveCount(0);
      await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
      await expect(activity).toContainText("Ready");
      await expect(detail).toHaveText("1 subagent running");
      // The mod is gone (a new launch without it): the polled activity alone.
      chat.frame({ type: "live-status", status: null });
      await expect(detail).toHaveCount(0);
      await expect(activity).toContainText("Ready");
    });
  });
