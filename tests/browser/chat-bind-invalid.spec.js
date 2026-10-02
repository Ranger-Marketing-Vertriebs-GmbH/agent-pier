import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

test("an unusable link response keeps the running chat and shows a message", async ({
  page,
}) => {
  const session = {
    id: "pick",
    name: "Pick",
    accountId: "local-claude",
    tool: "claude",
    status: "running",
    cwd: "/fixture",
  };
  const snapshot = {
    availability: "ready",
    providerSessionId: "native-one",
    messages: [{ id: "a", role: "assistant", text: "Still here" }],
    tasks: [],
    sync: { mode: "full", cursor: "one" },
    history: { cursor: null, generation: "native-one" },
  };
  await page.routeWebSocket("**/api/sessions/pick/chat-stream", (socket) => {
    socket.send(JSON.stringify({ type: "sync", sequence: 1, data: snapshot }));
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let result = {};
    if (url.pathname === "/api/state")
      result = {
        tools: [{ id: "claude", name: "claude", installed: true }],
        accounts: [],
        sessions: [session],
        home: "/fixture",
      };
    else if (url.pathname.endsWith("/chat/choices"))
      result = { choices: [{ id: "native-two-abcdef", title: "Other" }] };
    else if (url.pathname.endsWith("/chat")) result = snapshot;
    await route.fulfill({ json: result });
  });
  await page.goto(baseURL + "/sessions/pick/chat");
  const chat = page.locator(".chat-messages");
  await expect(chat).toContainText("Still here");
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await page
    .getByLabel("Conversation", { exact: true })
    .selectOption("native-two-abcdef");
  await page.locator(".conversation-picker button.primary").click();
  await expect(page.locator(".conversation-picker")).toContainText(
    "The chat could not be loaded completely. Retrying…",
  );
  await expect(chat).toContainText("Still here");
  await expect(page.locator(".conversation-picker button.primary")).toBeEnabled();
});
