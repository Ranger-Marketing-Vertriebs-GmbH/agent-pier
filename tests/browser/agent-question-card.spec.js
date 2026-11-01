import { test, expect } from "../helpers/browser-test.js";
import { setup } from "./assistant-shell-fixture.js";
import { openChat } from "./assistant-ssh-fixture.js";

// AGENTPIER-337: the question card of a Hermes agent's clarify question
// (QuestionCard.jsx), in English, on an intercepted chat feed. A choice and an own
// answer go to the answer route; a question the agent no longer waits for says so.
const question = {
  id: "q1",
  question: "Which environment should I deploy to?",
  choices: ["staging", "prod"],
  multiSelect: false,
  expiresAt: "2026-11-02T12:00:00.000Z",
};

async function questionFeed(page, { refuse = false } = {}) {
  const state = { answers: [], questions: [question] };
  await page.route(/\/api\/assistant-conversations\/chat\/(messages|stream)/, (route) =>
    route.request().url().includes("/stream")
      ? route.abort()
      : route.fulfill({
          json: { messages: [], requests: [], stale: false, questions: state.questions },
        }),
  );
  await page.route(
    /\/api\/assistant-conversations\/chat\/questions\/q1\/answer$/,
    (route) => {
      state.answers.push(route.request().postDataJSON());
      if (refuse)
        return route.fulfill({
          status: 409,
          json: {
            code: "questionGone",
            error: "The agent no longer waits for this answer.",
          },
        });
      state.questions = [];
      return route.fulfill({ json: { ok: true } });
    },
  );
  return state;
}

const card = (page) => page.getByRole("article", { name: "Question from the agent" });

test("a choice answers the agent's question and the card leaves", async ({ page }) => {
  await setup(page);
  const state = await questionFeed(page);
  await openChat(page);
  await expect(card(page)).toContainText("Which environment should I deploy to?");
  await expect(card(page)).toContainText("Waiting for your answer");
  await expect(card(page).getByRole("button", { name: "staging" })).toBeVisible();
  await card(page).getByRole("button", { name: "prod" }).click();
  await expect.poll(() => state.answers).toEqual([{ answer: "prod" }]);
  await expect(card(page)).toHaveCount(0);
});

test("an own answer is sent; a question nobody waits for any more says so", async ({
  page,
}) => {
  await setup(page);
  const state = await questionFeed(page, { refuse: true });
  await openChat(page);
  const send = card(page).getByRole("button", { name: "Send answer" });
  await expect(send).toBeDisabled();
  await card(page).getByLabel("Your answer").fill("the canary cluster");
  await send.click();
  await expect.poll(() => state.answers).toEqual([{ answer: "the canary cluster" }]);
  await expect(card(page)).toContainText("The agent no longer waits for this answer.");
});
