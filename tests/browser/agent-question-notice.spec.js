import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
import { inboxFixture } from "./inbox-fixture.js";

// A question an agent asks while its turn waits (server agent-questions.js) shows
// outside its chat too, in English: the agent's row and the chat header say that it
// waits for the owner's answer (the `agent.list` topic's activity), and the owner's
// inbox lists it under Questions with the chat's own card (the `inbox` topic). Both
// end with the answer. AGENTPIER_QUESTION_SCREENSHOTS names a folder for screenshots.
const shots = process.env.AGENTPIER_QUESTION_SCREENSHOTS;
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/question-push-${name}.png` });
};

const questions = [
  {
    id: "answer",
    header: "",
    text: "Which environment should I deploy to?",
    options: [{ label: "staging" }, { label: "prod" }],
    multiSelect: false,
    other: true,
  },
];
const nova = {
  id: "nova",
  name: "Nova",
  instructions: "Ship the release",
  model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
  revision: 1,
  effectiveRevision: 1,
};
const asking = {
  state: "waiting",
  reason: "question",
  label: "status.question",
  pendingApprovals: 0,
  team: null,
};

// One agent whose chat holds a waiting question until it is answered.
async function chatFixture(page) {
  const state = { waiting: true, answers: [] };
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(path)
    )
      return route.fallback();
    if (path.endsWith("/stream")) return route.abort();
    if (path.endsWith("/questions/ask_1/answer")) {
      state.answers.push(request.postDataJSON());
      state.waiting = false;
      return route.fulfill({ json: { ok: true, id: "ask_1" } });
    }
    let body = {};
    if (path === "/api/assistants")
      body = {
        assistants: [nova],
        conversations: [{ id: "release", assistantId: "nova" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        activity: state.waiting ? { nova: asking } : {},
      };
    else if (path === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (path.endsWith("/messages"))
      body = {
        messages: [],
        requests: [],
        stale: false,
        questions: state.waiting
          ? [{ id: "ask_1", questions, expiresAt: "2026-11-27T12:00:00.000Z" }]
          : [],
      };
    else if (path.endsWith("/conversations"))
      body = { id: "release", assistantId: "nova" };
    else if (path === "/api/assistants/nova") body = nova;
    await route.fulfill({ json: body });
  });
  return state;
}

test("the agent's row and the chat header say that it waits for the owner's answer", async ({
  page,
  liveStub,
}) => {
  const state = await chatFixture(page);
  await page.goto(baseURL + "/agents/nova/chats/release");
  const row = page.locator(".assistant-sidebar-item").filter({ hasText: "Nova" });
  await expect(row).toContainText("Waiting for your answer");
  const header = page.locator(".assistant-header-label");
  await expect(header).toHaveText("Waiting for your answer");
  const card = page.getByRole("article", { name: "Question from the agent" });
  await expect(card).toContainText("Which environment should I deploy to?");
  await shot(page, "chat");
  // The answer ends the question: the card leaves and the agent no longer waits.
  await card.getByRole("button", { name: "prod" }).click();
  await expect.poll(() => state.answers).toEqual([{ answers: { answer: ["prod"] } }]);
  await expect(card).toHaveCount(0);
  await liveStub.reread("agent.list");
  await expect(row).not.toContainText("Waiting for your answer");
  await expect(header).not.toHaveText("Waiting for your answer");
});

test("the inbox lists the agent's question and answers it with the chat's card", async ({
  page,
}) => {
  const state = await inboxFixture(page, { language: "en" });
  state.items.push({
    type: "question",
    tab: "questions",
    id: "ask_1",
    kind: "agent-question",
    status: "pending",
    revision: null,
    source: { kind: "agent", id: "helper", name: "Helper" },
    conversationId: "chat-1",
    title: "Which environment should I deploy to?",
    questions,
    createdAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    link: "/agents/helper/chats/chat-1",
  });
  const answers = [];
  await page.route(
    "**/api/assistant-conversations/chat-1/questions/ask_1/answer",
    (route) => {
      answers.push(route.request().postDataJSON());
      state.items = state.items.filter((item) => item.id !== "ask_1");
      state.revision++;
      return route.fulfill({ json: { ok: true, id: "ask_1" } });
    },
  );
  await page.goto(baseURL + "/inbox?tab=questions");
  const rows = page
    .getByRole("navigation", { name: "Waiting on you" })
    .getByRole("button");
  await expect(rows).toHaveCount(2);
  const row = rows.filter({ hasText: "Which environment should I deploy to?" });
  await expect(row).toContainText("Question from an agent · Helper");
  await row.click();
  await expect(page).toHaveURL(/\/inbox\/question\/ask_1\?tab=questions$/);
  const card = page.getByRole("article", { name: "Question from the agent" });
  await expect(card.getByRole("button", { name: "staging" })).toBeVisible();
  await shot(page, "inbox");
  await card.getByLabel("Your answer").fill("the canary cluster");
  await card.getByRole("button", { name: "Send answer" }).click();
  await expect
    .poll(() => answers)
    .toEqual([{ answers: { answer: ["the canary cluster"] } }]);
  await expect(rows).toHaveCount(1);
  await expect(card).toHaveCount(0);
  // A CLI's question keeps its own card under the same item type.
  await page.goto(baseURL + "/inbox/question/ask-alpha");
  await expect(page.getByText("Which framework should the app use?")).toBeVisible();
});
