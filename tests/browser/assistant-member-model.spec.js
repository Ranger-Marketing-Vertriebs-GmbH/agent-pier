import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const before = { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
  after = { connectionId: "router", modelId: "anthropic/claude-sonnet-5" };

// The server sends a temporary member with its lead's current model.
function setup(lifetime = "task") {
  return {
    assistants: [
      chatAssistant({ model: before }),
      chatAssistant({
        id: "member-0",
        name: "Research lead",
        model: before,
        teamMemberId: "member-0",
        teamId: "team",
        parentAssistantId: "home",
        lifetime,
      }),
    ],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "member-chat", assistantId: "member-0" },
    ],
    members: [
      {
        id: "member-0",
        kind: "member",
        assistantId: "member-0",
        teamId: "team",
        parentAssistantId: "home",
        name: "Research lead",
        role: "Research",
        assignment: "Compare the three biggest vendors",
        phase: "completed",
        lifetime,
        conversationId: "member-chat",
        revision: 1,
        inheritedRevision: 1,
        overrides:
          lifetime === "permanent"
            ? { model: false, instructions: false }
            : { instructions: false },
      },
    ],
    teams: [
      {
        id: "team",
        kind: "team",
        parentAssistantId: "home",
        objective: "Prepare the website relaunch",
        phase: "completed",
        memberIds: ["member-0"],
        revision: 1,
      },
    ],
  };
}

test("a task member's row and header show the lead's new model", async ({ page }) => {
  const state = await chatFixture(page, setup());
  await page.goto(baseURL + "/agents/member-0/chats/member-chat");
  const status = page.locator(".assistant-header-status");
  await expect(status).toContainText("· Research · openai/gpt-4.1-mini");
  const row = page.locator(".assistant-sidebar-member");
  if (!(await row.count())) await page.locator(".assistant-team-pill").click();
  await expect(row.locator("small").first()).toContainText("openai/gpt-4.1-mini");
  // The owner changes the lead's model; the member follows it.
  for (const agent of state.assistants) agent.model = after;
  await emit(page, { type: "change" });
  await expect(status).toContainText("· Research · anthropic/claude-sonnet-5");
  await expect(row.locator("small").first()).toContainText("anthropic/claude-sonnet-5");
});

test("a task member's profile names the lead's model instead of offering a choice", async ({
  page,
}) => {
  await chatFixture(page, setup());
  await page.goto(baseURL + "/agents/member-0/settings");
  await expect(
    page.getByText("Follows the lead's model.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".agent-profile-card")).toContainText("openai/gpt-4.1-mini");
  await expect(page.getByLabel("Model connection")).toHaveCount(0);
  await expect(page.getByText(/^Model: /)).toHaveCount(0);
  await expect(page.getByLabel("Name", { exact: true })).toBeEditable();
});

test("a permanent member's profile offers its own model", async ({ page }) => {
  await chatFixture(page, setup("permanent"));
  await page.goto(baseURL + "/agents/member-0/settings");
  await expect(page.getByLabel("Model connection")).toBeVisible();
  await expect(page.getByText("Follows the lead's model.", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Model: as taken over from the lead", { exact: true }),
  ).toBeVisible();
});
