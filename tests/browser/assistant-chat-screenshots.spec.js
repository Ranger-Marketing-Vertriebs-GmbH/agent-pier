// The agent chat screenshots of the agents guide and the README: the lead "Planner"
// in its chat, on a desktop with its permanent member "Research", a second agent and
// coding sessions in the sidebar, and on a phone. Normal runs only check the scene;
// AGENTPIER_UPDATE_DOC_SCREENSHOTS=1 refreshes the images under docs/screenshots.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";
import { docScreenshot } from "../helpers/doc-screenshots.js";

const model = { connectionId: "router", modelId: "anthropic/claude-sonnet-5" };
const session = (id, name, tool, project, state) => ({
  id,
  name,
  tool,
  cwd: `/fixture/${project}`,
  status: "running",
  activity: { state },
});

// The Planner chat with its team and sessions, opened.
async function openPlannerChat(page) {
  await chatFixture(page, {
    assistants: [
      chatAssistant({ id: "planner", name: "Planner", model }),
      chatAssistant({
        id: "research",
        name: "Research",
        model,
        teamMemberId: "research",
        teamId: "t1",
        parentAssistantId: "planner",
        lifetime: "permanent",
      }),
      chatAssistant({ id: "writer", name: "Writer", model }),
    ],
    conversations: [{ id: "c1", assistantId: "planner", main: true }],
    history: {
      messages: [
        {
          id: "q1",
          role: "user",
          text: "What is left before Friday's release? @Research, please check the open issues.",
        },
        {
          id: "a1",
          role: "assistant",
          text:
            "I asked Research to go through the open issues. Three items are left:\n\n" +
            "1. **Update notes** for the settings move\n" +
            "2. **Phone layout** check on the agent chat\n" +
            "3. **Backup** before the upgrade\n\n" +
            "Research will report back here. Shall I add a reminder for Thursday at 16:00?",
        },
        { id: "q2", role: "user", text: "Yes, please." },
        {
          id: "a2",
          role: "assistant",
          text: "Done: a reminder for Thursday at 16:00 is set in your Telegram chat.",
        },
      ],
      requests: [],
      stale: false,
    },
  });
  await page.route(/\/api\/state(\?|$)/, (route) =>
    route.fulfill({
      json: {
        home: "/fixture",
        tools: [
          { id: "claude", name: "Claude Code", installed: true },
          { id: "codex", name: "Codex", installed: true },
          { id: "opencode", name: "OpenCode", installed: true },
        ],
        accounts: [],
        sessions: [
          session("website", "Codex · website", "codex", "website", "working"),
          session("api", "Claude Code · api-server", "claude", "api-server", "idle"),
          session("docs", "OpenCode · docs", "opencode", "docs", "waiting"),
        ],
        providerConnections: [],
      },
    }),
  );
  await page.goto(`${baseURL}/agents/planner/chats/c1`);
  await expect(page.getByRole("main")).toContainText("Telegram chat");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an agent chat with a permanent team member in the sidebar", async ({ page }) => {
    await openPlannerChat(page);
    const sidebar = page.locator(".sidebar");
    await sidebar.getByRole("button", { name: "Show team members (1)" }).click();
    await expect(sidebar).toContainText("Research");
    await expect(sidebar).toContainText("api-server");
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: docScreenshot("docs/screenshots/agentpier-agent-chat-desktop.png"),
    });
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });

  test("the same agent chat on a phone", async ({ page }) => {
    await openPlannerChat(page);
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await page.screenshot({
      path: docScreenshot("docs/screenshots/agentpier-agent-chat-phone.png"),
    });
  });
});
