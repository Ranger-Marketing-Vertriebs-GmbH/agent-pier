// The chat presents the server's native delivery confirmation (events or screen):
// accepted shows "Accepted by CLI", a silent handoff asks after 8 s, a hook block
// offers resend.
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

const topic = "session.deliveries:delivery";

async function fixture(page, receipt) {
  const state = {
    inputs: [],
    messages: [],
    receipt: { status: "handed-off", ...receipt },
  };
  state.publish = await mockChatStream(page, () => ({
    availability: "ready",
    messages: state.messages,
    tasks: [],
  }));
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "Claude Code", installed: true }],
          accounts: [],
          sessions: [
            {
              id: "delivery",
              accountId: "local-claude",
              tool: "claude",
              createdAt: "2026-11-06",
              name: "Delivery",
              cwd: "/fixture",
              status: "running",
            },
          ],
          home: "/fixture",
        },
      });
    if (url.pathname.endsWith("/chat"))
      return route.fulfill({ json: { availability: "ready", messages: [], tasks: [] } });
    if (url.pathname.endsWith("/input")) {
      const body = req.postDataJSON();
      state.inputs.push(body);
      return route.fulfill({
        json: {
          deliveryId: body.deliveryId,
          status: "handed-off",
          confirmation: "events",
          submittedAt: Date.now(),
          ...state.receipt,
        },
      });
    }
    if (url.pathname.includes("/input/"))
      return route.fulfill({
        json: {
          deliveryId: url.pathname.split("/").at(-1),
          confirmation: "events",
          submittedAt: Date.now(),
          ...state.receipt,
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(baseURL + "/sessions/delivery/chat");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  return state;
}

async function sendMessage(page, text) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
const status = (page) => page.getByRole("status", { name: "Message delivery" });

test("an accepted push shows Accepted by CLI and keeps it after a reload", async ({
  page,
  liveStub,
}) => {
  const state = await fixture(page);
  await sendMessage(page, "Confirmed by the CLI");
  await expect(status(page)).toContainText("Sent to TUI");
  state.receipt = { status: "accepted", acceptedAt: Date.now() };
  await liveStub.changed(topic);
  await expect(page.locator(".chat-delivery-status")).toHaveCount(0);
  const badge = page.locator(".chat-native-delivery");
  await expect(badge).toHaveText("✓Accepted by CLI");
  await expect(page.locator(".chat-delivery-message")).toContainText(
    "Confirmed by the CLI",
  );
  await expect(page.getByRole("button", { name: "Dismiss delivery status" })).toHaveCount(
    0,
  );
  // The native row takes over the card and the badge moves with it: never twice.
  state.messages = [
    { id: "row", role: "user", text: "Confirmed by the CLI", timestamp: Date.now() },
  ];
  state.publish();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText("✓Accepted by CLI");
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText("✓Accepted by CLI");
});

test("an accepted command shows handed over briefly and keeps its message", async ({
  page,
  liveStub,
}) => {
  const state = await fixture(page, { command: true });
  await sendMessage(page, "/cost");
  state.receipt = { status: "accepted", command: true, acceptedAt: Date.now() };
  await liveStub.changed(topic);
  await expect(status(page)).toHaveText("Command handed over");
  await expect(page.locator(".chat-delivery-status")).toHaveCount(0, { timeout: 6000 });
  await expect(page.locator(".chat-delivery-message")).toContainText("/cost");
  await expect(page.locator(".chat-native-delivery")).toHaveCount(0);
});

test("a handoff without confirmation asks after eight seconds", async ({ page }) => {
  // The server clock is a minute behind: the ask still follows the browser's handoff.
  await fixture(page, { submittedAt: Date.now() - 60000 });
  await sendMessage(page, "Silent CLI");
  await expect(status(page)).toContainText("Sent to TUI");
  await expect(page.getByRole("button", { name: "Inspect handoff" })).toHaveCount(0);
  await page.waitForTimeout(6000);
  await expect(status(page)).toContainText("Sent to TUI");
  await expect(status(page)).toHaveText(
    "The CLI has not confirmed. Check the handoff or edit and resend the message.",
    { timeout: 6000 },
  );
  await expect(page.getByRole("button", { name: "Inspect handoff" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit message" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("delivery-ask.png") });
});

test("a released hook block offers resend from the chat", async ({ page, liveStub }) => {
  const state = await fixture(page);
  await sendMessage(page, "Blocked once");
  await expect(status(page)).toContainText("Sent to TUI");
  state.receipt = {
    status: "rejected",
    reason: "CHAT_HOOK_BLOCKED",
    released: true,
    hookReason: "No secrets in prompts",
  };
  await liveStub.changed(topic);
  await expect(status(page)).toContainText("Blocked by a hook");
  await expect(status(page)).toContainText("No secrets in prompts");
  await page.screenshot({ path: test.info().outputPath("delivery-hook-blocked.png") });
  state.receipt = { status: "handed-off" };
  await page.getByRole("button", { name: "Deliver again" }).click();
  await expect.poll(() => state.inputs.length).toBe(2);
  expect(state.inputs[1].text).toBe("Blocked once");
  expect(state.inputs[1].deliveryId).not.toBe(state.inputs[0].deliveryId);
  await expect(page.locator(".chat-delivery-message")).toHaveCount(1);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
});

test("a hook block with the text still in the CLI offers no resend", async ({
  page,
  liveStub,
}) => {
  const state = await fixture(page);
  await sendMessage(page, "Still in the prompt");
  await expect(status(page)).toContainText("Sent to TUI");
  state.receipt = {
    status: "rejected",
    reason: "CHAT_HOOK_BLOCKED_DRAFT",
    released: false,
  };
  await liveStub.changed(topic);
  await expect(status(page)).toContainText(
    "Blocked by a hook. The text is still in the CLI prompt.",
  );
  await expect(page.getByRole("button", { name: "Deliver again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open TUI" })).toBeVisible();
});

test("a blocked message still in the CLI prompt cannot be sent again from the composer", async ({
  page,
}) => {
  // The block arrives with the send's own answer: the text returns to the composer.
  const state = await fixture(page, {
    status: "rejected",
    reason: "CHAT_HOOK_BLOCKED_DRAFT",
    released: false,
  });
  await sendMessage(page, "Twice would double");
  await expect(status(page)).toContainText("The text is still in the CLI prompt.");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Twice would double",
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByLabel("Message", { exact: true }).press("Enter");
  // Dismissing clears the composer copy: the message lives on in the CLI prompt only.
  await page.getByRole("button", { name: "Dismiss delivery status" }).click();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByLabel("Message", { exact: true }).press("Enter");
  expect(state.inputs).toHaveLength(1);
  expect(
    state.inputs.filter((input) => input.text === "Twice would double"),
  ).toHaveLength(1);
});
