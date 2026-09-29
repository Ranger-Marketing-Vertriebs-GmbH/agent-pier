import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

test.use({
  locale: "en-GB",
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

async function fixture(page, tool = "codex") {
  const sizes = [];
  const session = {
    id: "mobile-viewport",
    name: "Mobile terminal",
    tool,
    accountId: `local-${tool}`,
    cwd: "/fixture",
    status: "running",
    purpose: "login",
  };
  const chat = { availability: "ready", messages: [], tasks: [] };
  await mockChatStream(page, () => chat);
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        pathname === "/api/state"
          ? {
              tools: [{ id: tool, name: tool, installed: true }],
              accounts: [{ id: session.accountId, name: "Fixture", tool, kind: "local" }],
              sessions: [session],
              home: "/fixture",
            }
          : pathname.endsWith("/chat")
            ? chat
            : {},
    });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
    const redraw = () =>
      socket.send(
        JSON.stringify({
          type: "output",
          data: "\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2JReady for input\r\n$ ",
        }),
      );
    socket.onMessage((message) => {
      const value = JSON.parse(message);
      if (value.type === "resize") {
        sizes.push(value);
        redraw();
      }
    });
    redraw();
  });
  await page.goto(baseURL + "/sessions/mobile-viewport/terminal");
  await expect(page.getByRole("status")).toHaveText("Connected");
  await expect.poll(() => sizes.length).toBeGreaterThan(0);
  await expect(page.locator(".xterm-rows")).toContainText("Ready for input");
  return sizes;
}

async function viewport(page, height, top = 0, event = "resize") {
  await page.evaluate(
    ({ height, top, event }) => {
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        value: height,
      });
      Object.defineProperty(window.visualViewport, "offsetTop", {
        configurable: true,
        value: top,
      });
      window.visualViewport.dispatchEvent(new Event(event));
    },
    { height, top, event },
  );
}

async function contained(page, height, top = 0) {
  await expect
    .poll(async () => (await page.locator(".app").boundingBox()).height)
    .toBe(height);
  const app = await page.locator(".app").boundingBox();
  expect(app.y).toBe(top);
  for (const selector of [".terminal-pane", ".xterm-screen", ".keyboard-toolbar"]) {
    await expect
      .poll(
        async () => {
          const box = await page.locator(selector).boundingBox();
          return box.y + box.height;
        },
        { message: `${selector} must fit after xterm's ResizeObserver updates` },
      )
      .toBeLessThanOrEqual(top + height + 1);
    const box = await page.locator(selector).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(top);
    expect(box.height).toBeGreaterThan(0);
  }
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - innerWidth,
    y: document.documentElement.scrollHeight - innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
  expect(overflow.y).toBeLessThanOrEqual(1);
}

for (const tool of ["codex", "shell"]) {
  test(`${tool}: keyboard opening and closing fits terminal rows and keeps toolbar visible`, async ({
    page,
  }) => {
    const sizes = await fixture(page, tool);
    await contained(page, 844);
    const rows = sizes.at(-1).rows;
    await page.locator(".xterm-helper-textarea").focus();
    expect(
      await page
        .locator(".xterm-helper-textarea")
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await viewport(page, 420);
    await contained(page, 420);
    await expect.poll(() => sizes.at(-1).rows).toBeLessThan(rows);
    const smallRows = sizes.at(-1).rows;
    await viewport(page, 420, 35, "scroll");
    await contained(page, 420, 35);
    await page.evaluate(() => window.scrollTo(0, 200));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await viewport(page, 0);
    await expect
      .poll(async () => (await page.locator(".app").boundingBox()).height)
      .toBe(420);
    await viewport(page, 844);
    await contained(page, 844);
    await expect.poll(() => sizes.at(-1).rows).toBeGreaterThan(smallRows);
  });
}

test("switching chat and terminal keeps keyboard height; leaving restores page layout", async ({
  page,
}) => {
  await fixture(page);
  await viewport(page, 420);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator(".mobile-chat-workspace")).toBeVisible();
  expect((await page.locator(".app").boundingBox()).height).toBe(420);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm-screen")).toBeVisible();
  await contained(page, 420);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator(".mobile-session-workspace")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--session-viewport-height"),
      ),
    )
    .toBe("");
  expect(
    await page.locator(".app").evaluate((element) => getComputedStyle(element).position),
  ).not.toBe("fixed");
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).overflow),
  ).not.toBe("hidden");
});

test("desktop breakpoint releases mobile positioning and returning restores it", async ({
  page,
}) => {
  await fixture(page);
  await viewport(page, 420);
  await page.setViewportSize({ width: 1100, height: 844 });
  await expect
    .poll(() =>
      page.locator(".app").evaluate((element) => getComputedStyle(element).position),
    )
    .not.toBe("fixed");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--session-viewport-height"),
      ),
    )
    .toBe("");
  await page.setViewportSize({ width: 390, height: 844 });
  await contained(page, 420);
  await expect
    .poll(async () => {
      const box = await page.locator(".sidebar").boundingBox();
      return box.x + box.width;
    })
    .toBeLessThanOrEqual(0);
  await expect(page.locator(".xterm-rows")).toContainText("Ready for input");
  await page.screenshot({
    path: "/tmp/agentpier-terminal-keyboard-viewport.png",
    clip: { x: 0, y: 0, width: 390, height: 420 },
  });
});
