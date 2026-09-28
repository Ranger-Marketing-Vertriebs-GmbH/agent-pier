import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "touch input is synthesized through CDP",
);

async function mobileTerminal(page) {
  const input = [];
  const session = {
    id: "touch-scroll",
    name: "Touch scroll",
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
    // tmux with "mouse on" draws on the alternate screen and requests SGR mouse
    // tracking, so the browser terminal holds no history of its own.
    socket.send(
      JSON.stringify({
        type: "output",
        data: "\x1b[?1049h\x1b[?1000h\x1b[?1006hTerminal history lives in tmux",
      }),
    );
  });
  await page.goto(baseURL + "/sessions/touch-scroll/terminal");
  await expect(page.getByRole("status")).toHaveText("Verbunden");
  await expect(page.locator(".xterm-rows")).toContainText("Terminal history");
  return input;
}

async function swipe(page, from, to) {
  const client = await page.context().newCDPSession(page);
  // Real touchmove events arrive a few pixels apart.
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 5);
  const point = (step) => [
    {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    },
  ];
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(0),
  });
  for (let step = 1; step <= steps; step++)
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(step),
    });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function recordTouchMoves(page) {
  await page.evaluate(() => {
    window.touchMoves = [];
    document.addEventListener("touchmove", (event) =>
      window.touchMoves.push(event.defaultPrevented),
    );
  });
}

test("swiping down on a phone scrolls terminal history instead of the page", async ({
  page,
}) => {
  const input = await mobileTerminal(page);
  await recordTouchMoves(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const x = box.x + box.width / 2;
  await swipe(page, { x, y: box.y + 40 }, { x, y: box.y + 240 });
  // Unprevented moves reach the browser, which answers with pull-to-refresh.
  await expect
    .poll(() => page.evaluate(() => window.touchMoves.length))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.touchMoves.every(Boolean))).toBe(true);
  // SGR wheel-up reports are what tmux enters copy mode and scrolls on.
  await expect.poll(() => input.join("")).toMatch(/\x1b\[<64;\d+;\d+M/);
});

test("a horizontal swipe sends nothing to the terminal", async ({ page }) => {
  const input = await mobileTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const y = box.y + box.height / 2;
  await swipe(page, { x: box.x + 40, y }, { x: box.x + box.width - 40, y });
  // Input is ordered, so a key typed afterwards bounds everything the swipe sent.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("x");
  await expect.poll(() => input.join("")).toContain("x");
  expect(input.join("")).not.toMatch(/\x1b\[<6[45];/);
});

test("a tap still focuses the terminal for the keyboard", async ({ page }) => {
  await mobileTerminal(page);
  await page.locator(".xterm-helper-textarea").evaluate((element) => element.blur());
  const box = await page.locator(".xterm-screen").boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [center],
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
});
