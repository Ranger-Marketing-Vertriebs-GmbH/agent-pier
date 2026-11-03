import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";

const refusal = "I never write keyloggers, not even for the owner.";
const phishing = "Refused a phishing mail for an awareness test.";
const review = {
  id: "review-one",
  createdAt: new Date().toISOString(),
  switch: { from: "GPT-4.1 mini", to: "Claude Sonnet 4.6" },
  assistantId: "home",
  assistantName: "Home assistant",
  conversationId: "dinner",
  revision: 1,
  agents: [
    {
      assistantId: "home",
      name: "Home assistant",
      entries: [
        { id: "e1", file: "MEMORY.md", entry: refusal, kind: "model-limit" },
        { id: "e2", file: "memory/2026-11-02.md", entry: phishing, kind: "model-limit" },
      ].map((e) => ({ ...e, recommendation: "archive" })),
    },
  ],
};
const item = {
  type: "memory-review",
  tab: "agents",
  id: review.id,
  kind: "memory-review",
  status: "awaiting_approval",
  revision: 1,
  source: { kind: "agent", id: "home", name: "Home assistant" },
  title: "GPT-4.1 mini → Claude Sonnet 4.6",
  createdAt: review.createdAt,
  expiresAt: null,
  link: "/agents/home/chats/dinner",
};

// The owner's chat with the review card waiting: the inbox lists it until applied.
async function reviewFixture(page) {
  const state = await chatFixture(page, {
    conversations: [{ id: "dinner", assistantId: "home", main: true }],
  });
  state.pending = true;
  await page.route("**/api/inbox", (route) =>
    route.fulfill({
      json: {
        instance: "fixture",
        revision: state.pending ? 1 : 2,
        counts: { all: 0, questions: 0, approvals: 0, gates: 0, agents: 0 },
        items: state.pending ? [item] : [],
      },
    }),
  );
  await page.route("**/api/assistant-memory-reviews**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      state.decision = request.postDataJSON();
      state.pending = false;
      return route.fulfill({ json: { archived: 1, kept: 1, changed: 0 } });
    }
    await route.fulfill({ json: { reviews: state.pending ? [review] : [] } });
  });
  return state;
}

test("a review with findings waits in the owner's chat and applies his choices", async ({
  page,
}) => {
  const state = await reviewFixture(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const card = page.locator("[data-memory-review]");
  await expect(card.getByText("Memory after the model switch")).toBeVisible();
  await expect(card).toContainText("From GPT-4.1 mini to Claude Sonnet 4.6");
  await expect(card).toContainText(refusal);
  await expect(card).toContainText("memory/2026-11-02.md");
  // Archive is chosen for every entry; the owner keeps the second one.
  const choice = (file) => card.getByRole("radiogroup", { name: `Entry in ${file}` });
  await expect(choice("MEMORY.md").getByLabel("Archive")).toBeChecked();
  await choice("memory/2026-11-02.md").getByText("Keep").click();
  await card.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() => state.decision)
    .toEqual({ revision: 1, choices: { e1: "archive", e2: "keep" } });
  await expect(page.getByText("1 archived · 1 kept")).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("another chat of the agent shows no card", async ({ page }) => {
  await reviewFixture(page);
  await page.route("**/api/assistants", (route) =>
    route.fulfill({
      json: {
        assistants: [chatAssistant()],
        conversations: [
          { id: "dinner", assistantId: "home", main: true },
          { id: "other", assistantId: "home" },
        ],
        models: [{ id: "router", name: "OpenRouter", available: true }],
      },
    }),
  );
  await page.goto(baseURL + "/agents/home/chats/other");
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  await expect(page.locator("[data-memory-review]")).toHaveCount(0);
});

test("restores an archived entry", async ({ page }) => {
  await chatFixture(page, {
    assistants: [chatAssistant({ capabilities: { memory: true, reminders: false } })],
  });
  const state = {
    content: "# Memory\n\n- The owner writes English.\n",
    archive: [
      {
        id: "a1",
        file: "MEMORY.md",
        text: refusal,
        archivedAt: "2026-11-02T10:00:00.000Z",
        switch: { from: "GPT-4.1 mini", to: "Claude Sonnet 4.6" },
      },
    ],
    reads: 0,
  };
  await page.route(/\/api\/assistants\/home\/memory/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/memory/archive"))
      return route.fulfill({ json: { entries: state.archive } });
    if (url.pathname.endsWith("/memory/archive/a1/restore")) {
      state.archive = [];
      state.content += `- ${refusal}\n`;
      return route.fulfill({ json: { restored: true, file: "MEMORY.md" } });
    }
    if (url.pathname.endsWith("/memory/files"))
      return route.fulfill({ json: { files: [], nextOffset: null } });
    state.reads++;
    await route.fulfill({
      json: { name: "MEMORY.md", content: state.content, hash: "a".repeat(64) },
    });
  });
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  const archive = page.getByRole("region", { name: "Archive" });
  await expect(archive).toContainText(refusal);
  await expect(archive).toContainText("MEMORY.md");
  await expect(archive).toContainText("From GPT-4.1 mini to Claude Sonnet 4.6");
  await expect(page.getByLabel("Saved notes")).toHaveValue(state.content);
  await archive.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(archive.getByText("No archived entries.")).toBeVisible();
  // The file view reads the note again: the entry is back at its end.
  await expect(page.getByLabel("Saved notes")).toHaveValue(
    `# Memory\n\n- The owner writes English.\n- ${refusal}\n`,
  );
  // Restore is no draft change: nothing waits to be saved.
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0);
});
