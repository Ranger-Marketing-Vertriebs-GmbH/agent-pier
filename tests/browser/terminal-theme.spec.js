import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
async function fixture(page) {
  const session = {
    id: "theme-fixture",
    name: "Native Farben",
    tool: "claude",
    accountId: "local-claude",
    cwd: "/fixture",
    status: "running",
  };
  const inputs = [];
  await page.route("**/api/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    const data =
      endpoint === "/api/state"
        ? {
            tools: [{ id: "claude", name: "Claude Code", installed: true }],
            accounts: [
              { id: "local-claude", name: "Claude Lokal", tool: "claude", kind: "local" },
            ],
            sessions: [session],
            home: "/fixture",
          }
        : endpoint.endsWith("/chat")
          ? {
              availability: "ready",
              messages: [
                { id: "reader", role: "assistant", text: "Chat bleibt unverändert." },
              ],
              tasks: [],
            }
          : endpoint.endsWith("/models")
            ? { currentModel: null, picker: null, pending: false }
            : {};
    await route.fulfill({ json: data });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
    socket.onMessage((message) => {
      const data = JSON.parse(message);
      if (data.type === "input") inputs.push(data.data);
    });
    socket.send(
      JSON.stringify({
        type: "output",
        data: "Native Äö · ✓\r\n\x1b[31mRED\x1b[0m\r\n\x1b[32mGREEN\x1b[0m\r\n\x1b[34mBLUE\x1b[0m\r\n\x1b[38;5;196mINDEXED\x1b[0m\r\n\x1b[38;2;18;52;86mTRUECOLOR\x1b[0m\r\n\x1b[48;2;17;34;51mBACKGROUND\x1b[0m\r\n❯ ",
      }),
    );
  });
  await page.goto(base + "/#theme-fixture");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByLabel("Interaktives Terminal")).toBeVisible();
  await expect(page.locator(".xterm-rows")).toContainText("Native Äö · ✓");
  return inputs;
}
test("native terminal keeps neutral defaults and renders CLI ANSI and true colors without brand tint", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.locator(".xterm-scrollable-element")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(page.locator(".terminal-pane")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(page.locator(".xterm-rows")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(page.locator(".xterm-fg-1").first()).toHaveCSS("color", "rgb(204, 0, 0)");
  await expect(page.locator(".xterm-fg-2").first()).toHaveCSS("color", "rgb(78, 154, 6)");
  await expect(page.locator(".xterm-fg-4").first()).toHaveCSS(
    "color",
    "rgb(52, 101, 164)",
  );
  await expect(page.locator(".xterm-fg-196").first()).toHaveCSS(
    "color",
    "rgb(255, 0, 0)",
  );
  await expect(
    page
      .locator(".xterm-rows > div")
      .filter({ hasText: "TRUECOLOR" })
      .locator("span")
      .first(),
  ).toHaveCSS("color", "rgb(18, 52, 86)");
  await expect(
    page
      .locator(".xterm-rows > div")
      .filter({ hasText: "BACKGROUND" })
      .locator("span")
      .first(),
  ).toHaveCSS("background-color", "rgb(17, 34, 51)");
  await page.getByLabel("Interaktives Terminal").screenshot({
    path: test.info().outputPath("native-terminal-colors.png"),
    animations: "disabled",
  });
});
test("native terminal still forwards UTF-8 and keyboard control input on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const inputs = await fixture(page);
  const keyboard = page.locator(".xterm-helper-textarea");
  await keyboard.focus();
  await keyboard.press("ArrowUp");
  await keyboard.press("Enter");
  await keyboard.pressSequentially("Grüße");
  await expect.poll(() => inputs.join("")).toContain("\x1b[A\rGrüße");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Chat bleibt unverändert.");
});
