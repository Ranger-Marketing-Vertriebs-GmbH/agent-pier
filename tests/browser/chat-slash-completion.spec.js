import { test, expect } from "@playwright/test";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });
async function fixture(page, tool) {
  const session = {
    id: "commands",
    accountId: "fixture",
    tool,
    cwd: "/fixture",
    status: "running",
    name: "Command completion",
  };
  const data = {
    availability: "ready",
    messages: [
      {
        id: "limit",
        role: "assistant",
        text: "You've hit your usage limit. Try again at 14:00.",
        status: "failed",
      },
    ],
    tasks: [],
  };
  const inputs = [];
  await mockChatStream(page, () => data);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let result = {};
    if (pathname === "/api/state")
      result = {
        sessions: [session],
        accounts: [],
        tools: [{ id: tool, name: tool, installed: true }],
        home: "/fixture",
      };
    if (pathname.endsWith("/chat")) result = data;
    if (pathname.endsWith("/input")) {
      const body = route.request().postDataJSON();
      inputs.push(body);
      result = { deliveryId: body.deliveryId, status: "handed-off" };
    }
    await route.fulfill({ json: result });
  });
  await page.goto(baseURL + "/sessions/commands/chat");
  await expect(page.getByText(data.messages[0].text, { exact: true })).toBeVisible();
  return { input: page.locator(".chat-composer textarea"), inputs };
}
for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: slash completion filters, accepts without sending, and submits once`, async ({
    page,
  }) => {
    const { input, inputs } = await fixture(page, tool);
    await input.fill("/mo");
    const command = tool === "opencode" ? "/models" : "/model";
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await expect(page.getByRole("option", { name: command, exact: true })).toBeVisible();
    await input.press("Tab");
    await expect(input).toHaveValue(command + " ");
    await expect(page.getByRole("listbox")).toBeHidden();
    expect(inputs).toHaveLength(0);
    await input.press("Enter");
    await expect.poll(() => inputs.length).toBe(1);
    expect(inputs[0].text.trim()).toBe(command);
  });
}
test("keyboard navigation, Escape, arguments and ordinary slashes preserve the draft", async ({
  page,
}) => {
  const { input, inputs } = await fixture(page, "codex");
  await input.fill("/sta");
  await input.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: "/statusline", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(input).toHaveValue("/statusline ");
  expect(inputs).toHaveLength(0);
  await input.fill("/comp");
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(input).toHaveValue("/comp");
  for (const text of [
    "/compact focus on tests",
    "look at /model",
    "/tmp/file",
    "/model\nnotes",
    "/unknown-command",
  ]) {
    await input.fill(text);
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(input).toHaveValue(text);
  }
});
test.describe("touch completion", () => {
  test.use({ hasTouch: true });
  test("mobile command selection stays above the composer and does not send", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    const { input, inputs } = await fixture(page, "claude");
    await input.fill("/comp");
    const popup = page.locator(".chat-slash-popup");
    await expect(popup).toBeVisible();
    const box = await popup.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: "/tmp/agentpier-slash-mobile.png",
      animations: "disabled",
    });
    await page.getByRole("option", { name: "/compact", exact: true }).tap();
    await expect(input).toHaveValue("/compact ");
    await expect(input).toBeFocused();
    expect(inputs).toHaveLength(0);
  });
});
