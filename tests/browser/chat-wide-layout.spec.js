// The session chat on a wide window and in a split pane: one reading column for the
// messages, the user's bubble and the composer; the task line of a pane opens the
// background tasks sheet over the whole window.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import {
  leaf,
  paneOf,
  split,
  splitViewFixture,
  viewId,
} from "../helpers/split-views-browser.js";

test.use({ viewport: { width: 1600, height: 1000 } });

// Screenshots for a pull request on demand: CHAT_LAYOUT_SHOTS names a folder.
const shots = process.env.CHAT_LAYOUT_SHOTS;
const shoot = (page, name) =>
  shots ? page.screenshot({ path: `${shots}/${name}.png` }) : null;

const chat = {
  availability: "ready",
  providerSessionId: "native-s1",
  messages: [
    { id: "u1", role: "user", text: "Move the invoice totals into their own module." },
    {
      id: "a1",
      role: "assistant",
      text: "I moved the totals into **billing/totals.js** and kept the old export as a re-export, so the callers keep working.\n\nThe tests for rounding now live next to the module.",
    },
    {
      id: "t1",
      role: "tool",
      toolName: "Read",
      status: "completed",
      text: "billing/totals.js",
    },
    { id: "u2", role: "user", text: "Thanks, run the tests." },
  ],
  tasks: [
    { id: "one", text: "Extract the totals", status: "completed" },
    { id: "two", text: "Run the billing tests", status: "in_progress" },
  ],
};

async function fixture(page, layout) {
  const controls = await splitViewFixture(page, { layout });
  await page.route("**/api/sessions/s1/chat", (route) => route.fulfill({ json: chat }));
  return controls;
}

const box = (locator) => locator.boundingBox();
const near = (actual, expected) => expect(Math.abs(actual - expected)).toBeLessThan(2);

test("on a wide window the bubble and the composer share the messages' column", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(`${baseURL}/sessions/s1/chat`);
  const reply = page.locator(".chat-message:not(.user)").first();
  await expect(reply).toContainText("billing/totals.js");
  const column = await box(reply);
  expect(column.width).toBe(820);
  const bubble = await box(page.locator(".chat-message.user").first());
  near(bubble.x + bubble.width, column.x + column.width);
  const composer = await box(page.locator(".chat-compose-area"));
  near(composer.x, column.x);
  near(composer.x + composer.width, column.x + column.width);
  await shoot(page, "chat-wide-column");
});

test("a pane's task line opens the background tasks sheet and closes on Escape", async ({
  page,
}) => {
  await fixture(page, split("row", leaf.s1("chat"), leaf.s2()));
  await page.goto(`${baseURL}/views/${viewId}`);
  const pane = paneOf(page, "session:s1");
  await expect(pane.locator(".chat-message.user").first()).toBeVisible();
  const line = pane.getByRole("button", { name: "Tasks 1/2", exact: true });
  await line.click();
  const sheet = page.getByRole("dialog", { name: "Background tasks" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Run the billing tests");
  // Modal over the window: the other pane waits until it closes.
  expect(await sheet.evaluate((element) => element.matches(":modal"))).toBe(true);
  await shoot(page, "split-pane-background-tasks");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(line).toBeFocused();
  // A click on its text keeps Escape working.
  await line.click();
  await sheet.getByText("Extract the totals").click();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
