// The session chat in a split pane: the task list of a pane opens as a drawer inside
// that pane, not over the whole window.
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

test("a pane's task list opens as a drawer inside the pane and closes on Escape", async ({
  page,
}) => {
  await fixture(page, split("row", leaf.s1("chat"), leaf.s2()));
  await page.goto(`${baseURL}/views/${viewId}`);
  const pane = paneOf(page, "session:s1");
  await expect(pane.locator(".chat-message.user").first()).toBeVisible();
  const toggle = pane.getByRole("button", { name: "Show tasks", exact: true });
  await toggle.click();
  const drawer = pane.getByRole("dialog", { name: "Task list" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Run the billing tests");
  // Non-modal: the other pane stays usable while it is open.
  expect(await drawer.evaluate((element) => element.matches(":modal"))).toBe(false);
  const inside = await box(drawer),
    bounds = await box(pane.locator(".chat-layout"));
  expect(inside.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(inside.y).toBeGreaterThanOrEqual(bounds.y - 1);
  expect(inside.x + inside.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(inside.y + inside.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  near(inside.height, bounds.height);
  expect(inside.width).toBeLessThanOrEqual(280);
  await shoot(page, "split-pane-tasks-drawer");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();
  // A click on its text keeps Escape working; a press outside it closes it.
  await toggle.click();
  await drawer.getByText("Extract the totals").click();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await toggle.click();
  await pane.locator(".chat-messages").click({ position: { x: 500, y: 40 } });
  await expect(drawer).toBeHidden();
});
