import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(page) {
  const sockets = [],
    messages = [];
  const session = {
    id: "wake-terminal",
    name: "Wake terminal",
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
    const index = sockets.length;
    sockets.push(socket);
    socket.onMessage((message) => messages.push({ index, ...JSON.parse(message) }));
    socket.send(JSON.stringify({ type: "output", data: `Connection ${index + 1}\r\n` }));
  });
  await page.goto(baseURL + "/sessions/wake-terminal/terminal");
  await expect(page.getByRole("status")).toHaveText("Verbunden");
  await expect(page.locator(".xterm-rows")).toContainText("Connection 1");
  return { sockets, messages };
}

async function wake(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new Event("online"));
  });
}

test("mobile wake replaces the socket once, restores geometry and never replays input", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { sockets, messages } = await fixture(page);
  await page.locator(".xterm-helper-textarea").press("a");
  await expect
    .poll(() =>
      messages
        .filter((m) => m.type === "input")
        .map((m) => m.data)
        .join(""),
    )
    .toBe("a");
  await wake(page);
  await expect.poll(() => sockets.length).toBe(2);
  await expect(page.locator(".xterm-rows")).toContainText("Connection 2");
  await expect
    .poll(() =>
      messages.some(
        (m) => m.index === 1 && m.type === "resize" && m.cols > 0 && m.rows > 0,
      ),
    )
    .toBe(true);
  await page.locator(".xterm-helper-textarea").press("b");
  await expect
    .poll(() =>
      messages
        .filter((m) => m.type === "input")
        .map((m) => m.data)
        .join(""),
    )
    .toBe("ab");
  expect(sockets).toHaveLength(2);
});

test("zero-sized terminal sends no resize and fits after becoming visible", async ({
  page,
}) => {
  const { sockets, messages } = await fixture(page);
  await page.getByLabel("Interaktives Terminal").evaluate((element) => {
    element.style.display = "none";
  });
  await wake(page);
  await expect.poll(() => sockets.length).toBe(2);
  await expect(page.getByRole("status")).toHaveText("Verbunden");
  expect(messages.filter((m) => m.index === 1 && m.type === "resize")).toEqual([]);
  await page.getByLabel("Interaktives Terminal").evaluate((element) => {
    element.style.display = "";
  });
  await expect
    .poll(() =>
      messages.some(
        (m) => m.index === 1 && m.type === "resize" && m.cols > 0 && m.rows > 0,
      ),
    )
    .toBe(true);
});
