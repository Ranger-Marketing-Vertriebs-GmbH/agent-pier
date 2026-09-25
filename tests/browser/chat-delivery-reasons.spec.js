import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatDeliveryCopy } from "../../server/lib/i18n/de/chat-delivery.js";

test.use({ locale: "en-GB", viewport: { width: 390, height: 844 } });

async function fixture(page, receipt, tool = "claude") {
  const state = { inputs: [] };
  const session = {
    id: "reasons",
    accountId: `local-${tool}`,
    tool,
    createdAt: "2026-09-22",
    name: "Reasons",
    cwd: "/fixture",
    status: "running",
  };
  await mockChatStream(page, () => ({ availability: "ready", messages: [], tasks: [] }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: tool, name: tool, installed: true }],
          accounts: [],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (url.pathname.endsWith("/chat"))
      return route.fulfill({ json: { availability: "ready", messages: [], tasks: [] } });
    if (url.pathname.endsWith("/input")) {
      const body = request.postDataJSON();
      state.inputs.push(body);
      // An oversized body never reaches the delivery service.
      if (!receipt) return route.fulfill({ status: 413, json: { error: "Too large" } });
      return route.fulfill({ json: { deliveryId: body.deliveryId, ...receipt } });
    }
    if (url.pathname.endsWith("/cancel")) {
      state.cancelled = { status: "rejected", reason: "CHAT_CANCELLED" };
      return route.fulfill({
        json: { deliveryId: url.pathname.split("/").at(-2), ...state.cancelled },
      });
    }
    if (url.pathname.includes("/input/"))
      return route.fulfill({
        json: {
          deliveryId: url.pathname.split("/").at(-1),
          ...(state.cancelled || receipt || { status: "absent" }),
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(baseURL + "/sessions/reasons/chat");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  return state;
}
const input = (page) => page.getByLabel("Message", { exact: true });

test("a rejection is explained in English and never locks the composer", async ({
  page,
}) => {
  const state = await fixture(page, {
    status: "rejected",
    reason: "CHAT_COMPOSER_DIALOG",
    error: "Claude zeigt gerade einen Dialog oder eine Auswahl.",
  });
  await input(page).fill("Do not approve anything");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Claude is showing a dialog or picker/)).toBeVisible();
  await expect(page.getByText(/Claude zeigt gerade/)).toHaveCount(0);
  // Nothing reached the terminal: the text is back in the usable composer.
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue("Do not approve anything");
  expect(state.inputs).toHaveLength(1);
});

test("handoff notices are shown in English without blocking the next message", async ({
  page,
}) => {
  await fixture(page, {
    status: "handed-off",
    notices: ["CHAT_APPENDED_TO_DRAFT", "CHAT_DIALOG_CLOSED"],
  });
  await input(page).fill("Continue with the tests");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("Sent together with text that was already in the terminal prompt.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/closed with Esc before sending/)).toBeVisible();
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue("");
  await page
    .locator(".chat-delivery-message")
    .screenshot({ path: test.info().outputPath("chat-delivery-notice-mobile.png") });
});

test("a held message frees the composer, can be cancelled and edited again", async ({
  page,
}) => {
  await fixture(page, { status: "pending", waiting: "dialog", pasted: false });
  await input(page).fill("After the question");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Waiting for a dialog in the TUI/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open TUI", exact: true })).toBeVisible();
  // The chat keeps working while the message waits.
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue("");
  await page
    .locator(".chat-delivery-message")
    .screenshot({ path: test.info().outputPath("chat-delivery-held-mobile.png") });
  await page.getByRole("button", { name: "Cancel sending", exact: true }).click();
  await expect(
    page.getByText("Cancelled before the message was typed into the TUI."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(input(page)).toHaveValue("After the question");
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
});

test("pasted text held for a dialog offers only the terminal, not cancel", async ({
  page,
}) => {
  await fixture(page, { status: "pending", waiting: "request", pasted: true });
  await input(page).fill("Already in the prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Waiting for the open request/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open TUI", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel sending", exact: true }),
  ).toHaveCount(0);
});

test("a message the server never accepted can be edited and dismissed", async ({
  page,
}) => {
  const state = await fixture(page, null);
  await input(page).fill("Too large for the server");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/The server did not accept this message/)).toBeVisible();
  await expect(input(page)).toBeDisabled();
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue("Too large for the server");
  await page
    .getByRole("button", { name: "Dismiss delivery status", exact: true })
    .click();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
  expect(state.inputs).toHaveLength(1);
});

test("a stored German receipt error without a reason code is shown in English", async ({
  page,
}) => {
  await fixture(page, { status: "rejected", error: chatDeliveryCopy.rejected });
  await input(page).fill("Check the receipt language");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText(/The input was rejected before the terminal handoff/),
  ).toBeVisible();
  await expect(page.getByText(/Die Eingabe wurde/)).toHaveCount(0);
});

test("unconfirmed Claude image chips are explained in English as pasted but unsent", async ({
  page,
}) => {
  await fixture(page, {
    status: "uncertain",
    reason: "CHAT_IMAGES_UNCONFIRMED",
    error: "Die Nachricht wurde in Claude eingefügt, aber nicht abgeschickt.",
  });
  await input(page).fill("Describe the attached screenshot");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText(
      /pasted into the CLI but not submitted: the CLI's input field does not show all attached images/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/eingefügt/)).toHaveCount(0);
});

test("a message with only its image chips in the prompt says so in English", async ({
  page,
}) => {
  await fixture(page, {
    status: "uncertain",
    pasted: "images",
    reason: "CHAT_QUESTION_OPEN",
    error: chatDeliveryCopy.imagesPastedReasons.CHAT_QUESTION_OPEN,
  });
  await input(page).fill("Describe the attached screenshot");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText(
      /attached images are in the TUI prompt, but the message was not completed and not submitted: Claude is waiting/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/The message is in the TUI prompt/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cancel sending", exact: true }),
  ).toHaveCount(0);
});

for (const tool of ["codex", "opencode"]) {
  test(`${tool}: unconfirmed submit is explained in English without naming Claude`, async ({
    page,
  }) => {
    await fixture(page, { status: "uncertain", reason: "CHAT_SUBMIT_UNCONFIRMED" }, tool);
    await input(page).fill("Check delivery");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText(
        "The CLI did not confirm that it accepted the message. Check the TUI before sending again.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/Claude did not confirm/)).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`${tool}-delivery.png`),
      fullPage: true,
    });
  });
}
