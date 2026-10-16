import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

const working = {
  id: "running",
  text: "Plan the week",
  state: "accepted",
  attempt: { id: "attempt", state: "accepted" },
};
const history = (attemptState) => ({
  messages: [{ id: "question", role: "user", text: "Plan the week" }],
  requests: [{ ...working, attempt: { ...working.attempt, state: attemptState } }],
  stale: false,
});
const stopButton = (page) =>
  page.getByRole("button", { name: "Stop response", exact: true });
const field = (page) => page.getByLabel("Message", { exact: true });
const cancels = (state) => state.calls.filter((p) => p.endsWith("/cancel"));

test("a message sent from a focused Send button never lets Enter reach Stop", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "keyboard focus on buttons is a desktop interaction");
  const state = await chatFixture(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await field(page).fill("Plan the week");
  // The Gateway accepts the turn: from now on the agent works on it.
  state.history = history("accepted");
  await page.getByRole("button", { name: "Send", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(stopButton(page)).toBeVisible();
  await expect(stopButton(page)).not.toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(cancels(state)).toEqual([]);
  await expect(stopButton(page)).toBeVisible();
});
