import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { inboxFixture } from "./inbox-fixture.js";

const rebuild = "0b8c1f7e-3d2a-4c5b-9e6f-7a8b9c0d1e2f";
const answers = (state) =>
  state.calls.filter((call) => call.path === `/craft/rebuilds/${rebuild}/answer`);

test("in English a rebuild's question and approval wait under Questions and are answered", async ({
  page,
}) => {
  const state = await inboxFixture(page, { language: "en", craft: true });
  await page.goto(baseURL + "/inbox?tab=questions");
  const list = page
    .getByRole("navigation", { name: "Waiting on you" })
    .getByRole("button");
  await expect(list).toHaveCount(3);
  await list.filter({ hasText: "Which colour should the buttons have?" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/inbox/craft/${rebuild}%3Aq1\\?tab=questions$`),
  );
  await expect(page.getByText("Question from a rebuild").first()).toBeVisible();
  await expect(page.getByText("The target uses two shades.")).toBeVisible();
  await expect(page.getByLabel("Your answer")).toBeVisible();
  await page
    .getByRole("group", { name: "Answers" })
    .getByRole("button", { name: "Blue", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "No longer waiting" })).toBeVisible();
  expect(answers(state).at(-1).body).toEqual({ questionId: "q1", choice: "Blue" });

  await list.filter({ hasText: "Install the dependencies?" }).click();
  await expect(page.getByLabel("What it would do")).toHaveText("npm install");
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Always allow", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No longer waiting" })).toBeVisible();
  expect(answers(state).at(-1).body).toEqual({
    questionId: "q2",
    allow: true,
    always: true,
  });
});

test("a rebuild question answered elsewhere in the meantime shows it no longer waits", async ({
  page,
}) => {
  const state = await inboxFixture(page, { language: "en", craft: true });
  // The Rebuilds page answered it; this tab's topic has not heard yet.
  state.answered.push("q1");
  await page.goto(`${baseURL}/inbox/craft/${rebuild}%3Aq1`);
  await page.getByLabel("Your answer").fill("Green, please");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No longer waiting" })).toBeVisible();
  expect(answers(state).at(-1).body).toEqual({ questionId: "q1", text: "Green, please" });
});
