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

// The server resolves the lead's model (assistant-member-model.test.js); this checks
// that the row and header show the model the server sends after a change.
test("a task member's row and header show the server-provided model after a change", async ({
  page,
}) => {
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

// Records the profile PATCH and answers with the member as the server stores it.
async function recordPatches(page, state) {
  const patches = [];
  await page.route(/\/api\/assistants\/member-0$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    patches.push(body);
    const member = state.assistants[1];
    if (body.model) Object.assign(member, { model: body.model, ownModel: true });
    if (body.followLead) {
      delete member.ownModel;
      member.model = state.assistants[0].model;
    }
    member.revision += 1;
    await route.fulfill({ json: member });
  });
  return patches;
}

test("a task member's profile follows the lead's model until the owner picks one", async ({
  page,
}) => {
  const state = await chatFixture(page, setup());
  const patches = await recordPatches(page, state);
  await page.goto(baseURL + "/agents/member-0/settings?tab=identity");
  const follow = page.getByRole("switch", { name: "Follow the lead's model" });
  await expect(follow).toBeChecked();
  await expect(
    page.getByText("Runs on the lead's current model and changes with it.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".agent-profile-card")).toContainText(
    "OpenRouter · openai/gpt-4.1-mini",
  );
  await expect(page.getByText("Manage connections", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Model connection")).toHaveCount(0);
  await expect(page.getByText(/^Model: /)).toHaveCount(0);
  await expect(page.getByLabel("Name", { exact: true })).toBeEditable();
  // The owner picks a model of its own: the regular fields, prefilled.
  await follow.click();
  await expect(page.getByLabel("Model connection")).toBeVisible();
  await page.getByLabel("Model ID", { exact: true }).fill("anthropic/claude-sonnet-5");
  await page.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({
    model: { connectionId: "router", modelId: "anthropic/claude-sonnet-5" },
  });
  expect(patches[0]).not.toHaveProperty("followLead");
  await expect(follow).not.toBeChecked();
  // And back: the member follows its lead again.
  await follow.click();
  await expect(page.locator(".agent-profile-card")).toContainText(
    "OpenRouter · openai/gpt-4.1-mini",
  );
  await page.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toMatchObject({ followLead: true });
  expect(patches[1]).not.toHaveProperty("model");
});

test("a permanent member's profile offers its own model", async ({ page }) => {
  await chatFixture(page, setup("permanent"));
  await page.goto(baseURL + "/agents/member-0/settings?tab=identity");
  await expect(page.getByLabel("Model connection")).toBeVisible();
  await expect(page.getByText("Manage connections", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Follow the lead's model" })).toHaveCount(
    0,
  );
  // The member card with its provenance sits in the Overview.
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(
    page.getByText("Model: as taken over from the lead", { exact: true }),
  ).toBeVisible();
});
