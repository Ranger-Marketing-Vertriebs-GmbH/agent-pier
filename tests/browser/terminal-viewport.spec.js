import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

test.use({
  locale: "en-GB",
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

async function fixture(page, tool = "codex", login = true) {
  const sizes = [];
  const inputs = [];
  const session = {
    id: "mobile-viewport",
    name: "Mobile terminal",
    tool,
    accountId: `local-${tool}`,
    cwd: "/fixture",
    status: "running",
    purpose: login ? "login" : undefined,
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
      if (value.type === "input") inputs.push(value.data);
    });
    redraw();
  });
  await page.goto(baseURL + "/sessions/mobile-viewport/terminal");
  await expect(page.getByRole("status")).toHaveText("Connected");
  await expect.poll(() => sizes.length).toBeGreaterThan(0);
  await expect(page.locator(".xterm-rows")).toContainText("Ready for input");
  return { sizes, inputs };
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
    const { sizes } = await fixture(page, tool);
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

test.describe("without a touch pointer", () => {
  test.use({ hasTouch: false, isMobile: false });

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
});

for (const size of [
  { width: 768, height: 1024, keyboardHeight: 580 },
  { width: 1024, height: 768, keyboardHeight: 360 },
  { width: 1366, height: 1024, keyboardHeight: 580 },
]) {
  test.describe(`iPad ${size.width}x${size.height}`, () => {
    // iPadOS can request a desktop layout while still using a touch keyboard.
    test.use({ isMobile: false, viewport: { width: size.width, height: size.height } });

    test("keeps terminal keys, chat composer and header within the keyboard viewport", async ({
      page,
    }) => {
      const { sizes, inputs } = await fixture(page, "codex", false);
      const rows = sizes.at(-1).rows;
      await page.locator(".xterm-helper-textarea").focus();
      await viewport(page, size.keyboardHeight);
      await contained(page, size.keyboardHeight);
      await expect.poll(() => sizes.at(-1).rows).toBeLessThan(rows);
      await viewport(page, size.keyboardHeight, 80, "scroll");
      await contained(page, size.keyboardHeight, 80);
      for (const [name, data] of [
        ["Send Up Arrow", "\x1b[A"],
        ["Send Down Arrow", "\x1b[B"],
        ["Send Left Arrow", "\x1b[D"],
        ["Send Right Arrow", "\x1b[C"],
      ]) {
        await page.getByRole("button", { name, exact: true }).click();
        await expect.poll(() => inputs.at(-1)).toBe(data);
      }
      await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
      expect(
        await page
          .locator(".xterm-helper-textarea")
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
      if (size.width === 1024) {
        await page.screenshot({
          path: "docs/screenshots/ipad-terminal-keyboard.png",
          clip: { x: 0, y: 80, width: size.width, height: size.keyboardHeight },
        });
      }

      await page.getByRole("button", { name: "Chat", exact: true }).click();
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("An unsent iPad draft");
      expect(
        await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
      await viewport(page, size.keyboardHeight, 130, "scroll");
      for (const selector of [
        ".session-heading",
        ".terminal-topbar",
        ".chat-composer-shell",
        ".sidebar",
      ]) {
        await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
        const box = await page.locator(selector).boundingBox();
        expect(box.y, selector).toBeGreaterThanOrEqual(130);
        expect(box.y + box.height, selector).toBeLessThanOrEqual(
          130 + size.keyboardHeight + 1,
        );
      }
      await page.evaluate(() => window.scrollTo(0, 200));
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await input.press("End");
      await input.press("!");
      await expect(input).toHaveValue("An unsent iPad draft!");
      await expect(page.locator(".chat-attachment-add")).toBeInViewport({ ratio: 1 });
      await expect(page.locator(".chat-send")).toBeInViewport({ ratio: 1 });
      if (size.width === 1024) {
        await page.screenshot({
          path: "docs/screenshots/ipad-chat-keyboard.png",
          clip: { x: 0, y: 130, width: size.width, height: size.keyboardHeight },
        });
      }
      await viewport(page, size.height);
      await expect
        .poll(async () => (await page.locator(".app").boundingBox()).height)
        .toBe(size.height);
      await expect(input).toHaveValue("An unsent iPad draft!");
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await contained(page, size.height);
      await expect.poll(() => sizes.at(-1).rows).toBe(rows);
    });
  });
}

test("touch rotation keeps the keyboard viewport and collapsed navigation aligned", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await fixture(page);
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  for (const size of [
    { width: 768, height: 1024, visible: 580 },
    { width: 1024, height: 768, visible: 360 },
    { width: 1366, height: 1024, visible: 580 },
  ]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await viewport(page, size.visible, 50);
    await contained(page, size.visible, 50);
    const toggle = await page.locator(".sidebar-float").boundingBox();
    expect(toggle.y).toBe(57);
    await expect(page.locator(".session-heading")).toBeInViewport({ ratio: 1 });
  }
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator(".mobile-session-workspace")).toHaveCount(0);
  await expect(page.locator(".app")).not.toHaveCSS("position", "fixed");
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--session-viewport-height"),
    ),
  ).toBe("");
});
