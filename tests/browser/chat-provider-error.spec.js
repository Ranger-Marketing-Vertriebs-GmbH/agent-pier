import { test, expect } from "../helpers/browser-test.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

// A provider's refusal of an OpenCode reply (AGENTPIER-411): the chat shows the
// error as an alert with a way to the model connections, not "Accepted by CLI" and
// then nothing.
test.use({ locale: "en-GB" });
test("a provider error shows as an alert that links to the model connections", async ({
  page,
}) => {
  const session = {
    id: "provider",
    accountId: "fixture",
    tool: "opencode",
    cwd: "/fixture",
    status: "running",
    name: "Provider refusal",
  };
  const data = {
    availability: "ready",
    messages: [
      { id: "ask", role: "user", text: "Summarize the README." },
      {
        id: "opencode-error:msg_2",
        role: "assistant",
        text: "Incorrect API key provided.",
        status: "failed",
        notice: "provider-error",
      },
    ],
    tasks: [],
  };
  await mockChatStream(page, () => data);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let result = {};
    if (pathname === "/api/state")
      result = {
        sessions: [session],
        accounts: [],
        tools: [{ id: "opencode", name: "opencode", installed: true }],
        home: "/fixture",
      };
    if (pathname.endsWith("/chat")) result = data;
    await route.fulfill({ json: result });
  });
  await page.goto(baseURL + "/sessions/provider/chat");
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Incorrect API key provided." });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("The model provider refused the request");
  const link = alert.getByRole("link", { name: "Open model access" });
  await expect(link).toHaveAttribute("href", "/connections?section=models");
});
