import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatDeliveryCopy } from "../../server/lib/i18n/de/chat-delivery.js";

test.use({ locale: "en-GB", viewport: { width: 390, height: 844 } });

async function fixture(page, receipt) {
  const state = { inputs: [] };
  const session = {
    id: "reasons",
    accountId: "local-claude",
    tool: "claude",
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
          tools: [{ id: "claude", name: "Claude Code", installed: true }],
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
    if (url.pathname.includes("/input/"))
      return route.fulfill({
        json: {
          deliveryId: url.pathname.split("/").at(-1),
          ...(receipt || { status: "absent" }),
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(baseURL + "/sessions/reasons/chat");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  return state;
}
const input = (page) => page.getByLabel("Message", { exact: true });

test("a Claude dialog rejection is explained in English and keeps the draft", async ({
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
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue("Do not approve anything");
  expect(state.inputs).toHaveLength(1);
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
