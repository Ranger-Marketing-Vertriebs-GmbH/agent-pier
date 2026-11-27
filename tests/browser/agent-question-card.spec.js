import { test, expect } from "../helpers/browser-test.js";
import { setup } from "./assistant-shell-fixture.js";
import { openChat } from "./assistant-ssh-fixture.js";

// AGENTPIER-337: the question card of an agent's question to the owner (OpenClaw's
// ask_user, Hermes's clarify; QuestionCard.jsx), in English, on an intercepted chat
// feed. A request holds one to three questions. One with plain options answers with
// a click or an own answer; several questions, a multiple choice or described options
// are a form sent in one piece. A question the agent no longer waits for says so.
const single = {
  id: "q1",
  questions: [
    {
      id: "answer",
      header: "",
      text: "Which environment should I deploy to?",
      options: [{ label: "staging" }, { label: "prod" }],
      multiSelect: false,
      other: true,
    },
  ],
  expiresAt: "2026-11-02T12:00:00.000Z",
};
const several = {
  id: "q1",
  questions: [
    {
      id: "stage",
      header: "Stage",
      text: "Which stage?",
      options: [
        { label: "Staging (Recommended)", description: "The test system" },
        { label: "Production" },
      ],
      multiSelect: false,
      other: true,
    },
    {
      id: "regions",
      header: "Regions",
      text: "Which regions?",
      options: [{ label: "EU" }, { label: "US" }, { label: "Asia" }],
      multiSelect: true,
      other: false,
    },
    {
      id: "note",
      header: "Note",
      text: "Anything else?",
      options: [],
      multiSelect: false,
      other: true,
    },
  ],
  expiresAt: "2026-11-02T12:00:00.000Z",
};

async function questionFeed(page, { refuse = false, question = single } = {}) {
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
  await expect.poll(() => state.answers).toEqual([{ answers: { answer: ["prod"] } }]);
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
  await expect
    .poll(() => state.answers)
    .toEqual([{ answers: { answer: ["the canary cluster"] } }]);
  await expect(card(page)).toContainText("The agent no longer waits for this answer.");
});

test("three questions are answered in one piece: a choice, several options, an own text", async ({
  page,
}) => {
  await setup(page);
  const state = await questionFeed(page, { question: several });
  await openChat(page);
  const stage = card(page).getByRole("group", { name: "Stage: Which stage?" });
  const regions = card(page).getByRole("group", { name: "Regions: Which regions?" });
  const note = card(page).getByRole("group", { name: "Note: Anything else?" });
  // Options show their description; a multiple choice takes no own answer here.
  await expect(stage).toContainText("The test system");
  await expect(regions.getByRole("checkbox")).toHaveCount(3);
  await expect(regions.getByText("Other answer")).toHaveCount(0);
  const send = card(page).getByRole("button", { name: "Send answer" });
  await expect(send).toBeDisabled();
  await stage.getByRole("radio", { name: "Production" }).check();
  await regions.getByRole("checkbox", { name: "EU" }).check();
  await regions.getByRole("checkbox", { name: "Asia" }).check();
  // Every question needs its answer before the request can be sent.
  await expect(send).toBeDisabled();
  await note.getByLabel("Other answer: Anything else?").fill("Ship it on Friday");
  await send.click();
  await expect
    .poll(() => state.answers)
    .toEqual([
      {
        answers: {
          stage: ["Production"],
          regions: ["EU", "Asia"],
          note: ["Ship it on Friday"],
        },
      },
    ]);
  await expect(card(page)).toHaveCount(0);
});

test("an own answer replaces the options of a single choice", async ({ page }) => {
  await setup(page);
  const state = await questionFeed(page, {
    question: { ...several, questions: [several.questions[0]] },
  });
  await openChat(page);
  const stage = card(page).getByRole("group", { name: "Stage: Which stage?" });
  await stage.getByRole("radio", { name: "Production" }).check();
  await stage.getByRole("radio", { name: "Other answer" }).check();
  await stage.getByLabel("Other answer: Which stage?").fill("the canary cluster");
  await card(page).getByRole("button", { name: "Send answer" }).click();
  await expect
    .poll(() => state.answers)
    .toEqual([{ answers: { stage: ["the canary cluster"] } }]);
});
