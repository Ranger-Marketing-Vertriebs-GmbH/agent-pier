// The chat presents the server's native delivery confirmation (events or screen):
// accepted hides the notice, a silent handoff asks after 8 s, a hook block offers resend.
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

const topic = "session.deliveries:delivery";

async function fixture(page, receipt) {
  const state = { inputs: [], receipt: { status: "handed-off", ...receipt } };
  await mockChatStream(page, () => ({ availability: "ready", messages: [], tasks: [] }));
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

test("an accepted push removes the notice and keeps the sent message", async ({
  page,
  liveStub,
}) => {
  const state = await fixture(page);
  await sendMessage(page, "Confirmed by the CLI");
  await expect(status(page)).toContainText("Sent to TUI");
  state.receipt = { status: "accepted", acceptedAt: Date.now() };
  await liveStub.changed(topic);
  await expect(page.locator(".chat-delivery-status")).toHaveCount(0);
  await expect(page.locator(".chat-delivery-message")).toContainText(
    "Confirmed by the CLI",
  );
  await expect(page.getByRole("button", { name: "Dismiss delivery status" })).toHaveCount(
    0,
  );
});

test("an accepted command shows handed over briefly, then hides", async ({
  page,
  liveStub,
}) => {
  const state = await fixture(page, { command: true });
  await sendMessage(page, "/cost");
  state.receipt = { status: "accepted", command: true, acceptedAt: Date.now() };
  await liveStub.changed(topic);
  await expect(status(page)).toHaveText("Command handed over");
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0, { timeout: 6000 });
});

test("a handoff without confirmation asks after eight seconds", async ({ page }) => {
  // Handed off six seconds ago: the client timer switches to the question.
  await fixture(page, { submittedAt: Date.now() - 6000 });
  await sendMessage(page, "Silent CLI");
  await expect(status(page)).toContainText("Sent to TUI");
  await expect(page.getByRole("button", { name: "Inspect handoff" })).toHaveCount(0);
  await expect(status(page)).toHaveText("The CLI has not confirmed. Check or resend.", {
    timeout: 6000,
  });
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
