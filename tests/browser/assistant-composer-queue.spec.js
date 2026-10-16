import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const shots = process.env.AGENTPIER_QUEUE_SHOTS;
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
const notice = "Will be sent when Home assistant is done";
const stopButton = (page) =>
  page.getByRole("button", { name: "Stop response", exact: true });
const field = (page) => page.getByLabel("Message", { exact: true });
const queued = (page) => page.getByRole("status").filter({ hasText: notice });
const cancels = (state) => state.calls.filter((p) => p.endsWith("/cancel"));

// The agent works on "Plan the week": Stop has replaced Send.
async function startWorking(page, options = {}) {
  const state = await chatFixture(page, { history: history("accepted"), ...options });
  await page.route(/\/api\/assistant-attempts\/[^/]+\/cancel$/, async (route) => {
    state.calls.push(new URL(route.request().url()).pathname);
    state.history = history("cancelled");
    await route.fulfill({ json: { id: "attempt", state: "cancelled" } });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(stopButton(page)).toBeVisible();
  return state;
}
async function finish(page, state, attemptState = "completed") {
  state.history = history(attemptState);
  await emit(page, { type: "change" });
}

test("Enter while the agent works queues the message instead of stopping it", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Enter breaks the line on touch input");
  const state = await startWorking(page);
  await field(page).click();
  await field(page).pressSequentially("And add a dessert");
  await field(page).press("Enter");
  await expect(queued(page)).toContainText("And add a dessert");
  await expect(field(page)).toHaveValue("");
  await expect(field(page)).toBeFocused();
  await expect(stopButton(page)).toBeVisible();
  expect(cancels(state)).toEqual([]);
  expect(state.posted).toEqual([]);

  // A second Enter adds to the same queued message, on its own line.
  await field(page).pressSequentially("Without nuts");
  await field(page).press("Enter");
  await expect(queued(page)).toHaveCount(1);

  await finish(page, state);
  await expect.poll(() => state.posted.length).toBe(1);
  expect(state.posted[0].text).toBe("And add a dessert\nWithout nuts");
  expect(state.posted[0].clientRequestId).toBeTruthy();
  await expect(queued(page)).toHaveCount(0);
  // Later refreshes never send it again.
  await emit(page, { type: "change" });
  await emit(page, { type: "change" });
  await page.waitForTimeout(300);
  expect(state.posted).toHaveLength(1);
  expect(cancels(state)).toEqual([]);
});

test("Edit takes the queued message back into the composer", async ({ page }) => {
  const state = await startWorking(page);
  await field(page).fill("Swap Tuesday and Friday");
  await page.getByRole("button", { name: "Send when done", exact: true }).click();
  await expect(queued(page)).toContainText("Swap Tuesday and Friday");
  await expect(field(page)).toHaveValue("");
  await field(page).fill("Also Sunday");
  await page.getByRole("button", { name: "Edit queued message", exact: true }).click();
  await expect(queued(page)).toHaveCount(0);
  await expect(field(page)).toHaveValue("Swap Tuesday and Friday\nAlso Sunday");
  await finish(page, state);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(state.posted).toEqual([]);
});

test("Stop still stops, and the queued message follows the stopped turn", async ({
  page,
}) => {
  const state = await startWorking(page);
  await field(page).fill("Start over with fish");
  await page.getByRole("button", { name: "Send when done", exact: true }).click();
  await expect(queued(page)).toBeVisible();
  expect(state.posted).toEqual([]);
  await stopButton(page).click();
  await expect
    .poll(() => cancels(state))
    .toEqual(["/api/assistant-attempts/attempt/cancel"]);
  await expect
    .poll(() => state.posted.map((p) => p.text))
    .toEqual(["Start over with fish"]);
});

test("a queued message carries its files", async ({ page }) => {
  const state = await startWorking(page);
  const uploads = [];
  await page.route(/\/api\/assistant-conversations\/dinner\/attachment/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/attachment-policy"))
      return route.fulfill({
        json: { imageInput: true, maxBytes: 10485760, maxFiles: 5 },
      });
    if (route.request().method() !== "POST")
      return route.fulfill({ status: 204, body: "" });
    uploads.push(url.searchParams.get("name"));
    return route.fulfill({
      status: 201,
      json: { id: "file-1", name: "notes.md", size: 9, type: "text/plain", kind: "text" },
    });
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Dessert"),
  });
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("notes.md");
  await field(page).fill("Use these notes");
  await page.getByRole("button", { name: "Send when done", exact: true }).click();
  await expect(queued(page)).toContainText("1 file");
  await expect(page.getByRole("list", { name: "Attachments" })).toHaveCount(0);
  await finish(page, state, "failed");
  await expect.poll(() => state.posted.length).toBe(1);
  expect(state.posted[0]).toMatchObject({
    text: "Use these notes",
    attachments: ["file-1"],
  });
});

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

test("on a phone, Send when done queues next to Stop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await startWorking(page);
  await expect(page.getByRole("button", { name: "Send when done" })).toHaveCount(0);
  await field(page).fill("Add a shopping list");
  const later = page.getByRole("button", { name: "Send when done", exact: true });
  await expect(later).toBeVisible();
  const [laterBox, stopBox] = [
    await later.boundingBox(),
    await stopButton(page).boundingBox(),
  ];
  expect(laterBox.x + laterBox.width).toBeLessThanOrEqual(stopBox.x);
  expect(Math.abs(laterBox.y - stopBox.y)).toBeLessThanOrEqual(2);
  if (shots) await page.screenshot({ path: `${shots}/send-when-done-phone-en.png` });
  await later.click();
  await expect(queued(page)).toContainText("Add a shopping list");
  await expect(page.getByRole("button", { name: "Edit queued message" })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  if (shots)
    await page.screenshot({ path: `${shots}/queued-phone-en.png`, fullPage: false });
  await finish(page, state);
  await expect
    .poll(() => state.posted.map((p) => p.text))
    .toEqual(["Add a shopping list"]);
});

test("leaving the chat returns the queued message to the draft", async ({ page }) => {
  const state = await startWorking(page);
  await field(page).fill("Keep this for later");
  await page.getByRole("button", { name: "Send when done", exact: true }).click();
  await expect(queued(page)).toBeVisible();
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
  await expect(field(page)).toHaveValue("Keep this for later");
  await expect(queued(page)).toHaveCount(0);
  await finish(page, state);
  await page.waitForTimeout(300);
  expect(state.posted).toEqual([]);
});
