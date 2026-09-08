import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function loginTerminal(page) {
  const input = [];
  const session = {
    id: "paste-login",
    name: "Claude login",
    accountId: "local-claude",
    tool: "claude",
    purpose: "login",
    status: "running",
    cwd: "/fixture",
  };
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === "/api/state"
          ? {
              tools: [{ id: "claude", name: "Claude Code", installed: true }],
              accounts: [
                { id: "local-claude", name: "Claude", tool: "claude", kind: "local" },
              ],
              sessions: [session],
              home: "/fixture",
            }
          : {},
    }),
  );
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
    socket.onMessage((message) => {
      const value = JSON.parse(message);
      if (value.type === "input") input.push(value.data);
    });
    socket.send(
      JSON.stringify({ type: "output", data: "Paste the authentication code here > " }),
    );
  });
  await page.goto(baseURL + "/sessions/paste-login/terminal");
  await expect(page.getByRole("status")).toHaveText("Verbunden");
  await expect(page.locator(".xterm-rows")).toContainText(
    "Paste the authentication code",
  );
  return input;
}
async function pasteAtFocus(page, text) {
  // A browser paste event without reading or replacing the user's OS clipboard.
  await page.evaluate((value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    document.activeElement.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, clipboardData }),
    );
  }, text);
}

test("Claude login terminal accepts a paste exactly once without submitting it", async ({
  page,
}) => {
  const input = await loginTerminal(page);
  await page.getByLabel("Interaktives Terminal").click();
  await pasteAtFocus(page, "synthetic-login-code#state");
  await expect.poll(() => input.join("")).toBe("synthetic-login-code#state");
});

test("selecting the active Terminal tab restores the paste target", async ({ page }) => {
  const input = await loginTerminal(page);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await pasteAtFocus(page, "synthetic-login-code#state");
  await expect.poll(() => input.join("")).toBe("synthetic-login-code#state");
});
