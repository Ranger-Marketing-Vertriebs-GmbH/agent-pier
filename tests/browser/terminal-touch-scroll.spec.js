import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test.use({
  locale: "en-GB",
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

async function mobileTerminal(page) {
  const input = [];
  let output;
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
    output = (data) => socket.send(JSON.stringify({ type: "output", data }));
    socket.onMessage((message) => {
      const value = JSON.parse(message);
      if (value.type === "input") input.push(value.data);
    });
    // tmux with "mouse on" draws on the alternate screen and requests SGR mouse
    // tracking, so the browser terminal holds no history of its own.
    output("\x1b[?1049h\x1b[?1000h\x1b[?1006hTerminal history lives in tmux");
  });
  await page.goto(baseURL + "/sessions/touch-scroll/terminal");
  await expect(page.getByRole("status")).toHaveText("Connected");
  await expect(page.locator(".xterm-rows")).toContainText("Terminal history");
  await recordTouchMoves(page);
  return { input, output };
}

async function nativeSwipe(page, from, to) {
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
  await client.detach();
}

async function recordTouchMoves(page) {
  await page.evaluate(() => {
    window.touchMoves = [];
    document.addEventListener("touchmove", (event) =>
      window.touchMoves.push(event.defaultPrevented),
    );
  });
}

async function flushInput(page, input) {
  // Input is ordered, so a key typed afterwards bounds everything the swipe sent.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("x");
  await expect.poll(() => input.at(-1)).toBe("x");
}

// DOM events exercise the real touch handler, xterm and WebSocket input in both
// engines. They cannot prove native browser gestures; CDP covers those separately.
async function domTouch(page, type, points, changedPoints = points) {
  const touches = (values) =>
    values.map(({ x, y, id }, index) => ({
      identifier: id ?? index,
      clientX: x,
      clientY: y,
    }));
  // Playwright also supports engines without a public Touch constructor.
  // https://playwright.dev/docs/touch-events
  await page.locator(".xterm-screen").dispatchEvent(type, {
    touches: touches(points),
    targetTouches: touches(points),
    changedTouches: touches(changedPoints),
  });
  if (type === "touchmove") return page.evaluate(() => window.touchMoves.at(-1));
}

async function domMoves(page, from, to) {
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 5);
  const prevented = [];
  for (let step = 1; step <= steps; step++) {
    prevented.push(
      await domTouch(page, "touchmove", [
        {
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
        },
      ]),
    );
  }
  return prevented;
}

const directions = [
  { name: "down", start: 40, middle: 140, end: 240, report: /\x1b\[<64;\d+;\d+M/ },
  { name: "up", start: 240, middle: 140, end: 40, report: /\x1b\[<65;\d+;\d+M/ },
];

for (const direction of directions) {
  test(`DOM swipe ${direction.name} keeps scrolling through terminal redraws`, async ({
    page,
  }) => {
    const { input, output } = await mobileTerminal(page);
    const box = await page.locator(".xterm-screen").boundingBox();
    const point = (offset) => ({ x: box.x + box.width / 2, y: box.y + offset });
    const start = point(direction.start);
    const middle = point(direction.middle);
    const end = point(direction.end);
    await domTouch(page, "touchstart", [start]);
    const firstMoves = await domMoves(page, start, middle);
    await expect
      .poll(() => input.filter((data) => direction.report.test(data)).length)
      .toBeGreaterThan(0);
    const beforeRedraw = input.length;
    // A real tmux redraw replaces the displayed text before the finger lifts.
    output("\x1b[H\x1b[2JRedrawn terminal history");
    await expect(page.locator(".xterm-rows")).toContainText("Redrawn terminal history");
    const lastMoves = await domMoves(page, middle, end);
    await domTouch(page, "touchend", [], [end]);
    await flushInput(page, input);
    expect(input.slice(beforeRedraw).join("")).toMatch(direction.report);
    expect([...firstMoves, ...lastMoves].every(Boolean)).toBe(true);
    expect(input.slice(0, -1).every((data) => direction.report.test(data))).toBe(true);
  });
}

test("DOM horizontal swipe sends no terminal input", async ({ page }) => {
  const { input } = await mobileTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const start = { x: box.x + 40, y: box.y + 100 };
  const end = { x: box.x + box.width - 40, y: start.y };
  await domTouch(page, "touchstart", [start]);
  await domMoves(page, start, end);
  await domTouch(page, "touchend", [], [end]);
  await flushInput(page, input);
  expect(input).toEqual(["x"]);
});

test("DOM two-finger moves stay with the browser and send no terminal input", async ({
  page,
}) => {
  const { input } = await mobileTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const start = [
    { x: box.x + 80, y: box.y + 60, id: 0 },
    { x: box.x + 200, y: box.y + 60, id: 1 },
  ];
  await domTouch(page, "touchstart", [start[0]]);
  await domTouch(page, "touchstart", start, [start[1]]);
  const moved = start.map((point) => ({ ...point, y: point.y + 120 }));
  expect(await domTouch(page, "touchmove", moved)).toBe(false);
  await domTouch(page, "touchend", [], moved);
  await flushInput(page, input);
  expect(input).toEqual(["x"]);

  // Multi-touch must not disable a later single-finger swipe.
  await domTouch(page, "touchstart", [start[0]]);
  await domMoves(page, start[0], moved[0]);
  await domTouch(page, "touchend", [], [moved[0]]);
  await expect.poll(() => input.join("")).toMatch(/\x1b\[<64;\d+;\d+M/);
});

test("a tap still focuses the terminal for the keyboard", async ({ page }) => {
  await mobileTerminal(page);
  await page.locator(".xterm-helper-textarea").evaluate((element) => element.blur());
  const box = await page.locator(".xterm-screen").boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.touchscreen.tap(center.x, center.y);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
});

test.describe("native Chromium gestures", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "native swipes and pinch zoom require CDP",
  );

  for (const direction of directions) {
    test(`swiping ${direction.name} scrolls terminal history instead of the page`, async ({
      page,
    }) => {
      const { input } = await mobileTerminal(page);
      const box = await page.locator(".xterm-screen").boundingBox();
      const x = box.x + box.width / 2;
      await nativeSwipe(
        page,
        { x, y: box.y + direction.start },
        { x, y: box.y + direction.end },
      );
      // Unprevented moves reach the browser, which can answer with pull-to-refresh.
      await expect
        .poll(() => page.evaluate(() => window.touchMoves.length))
        .toBeGreaterThan(0);
      expect(await page.evaluate(() => window.touchMoves.every(Boolean))).toBe(true);
      await expect.poll(() => input.join("")).toMatch(direction.report);
    });
  }

  test("a horizontal swipe sends nothing to the terminal", async ({ page }) => {
    const { input } = await mobileTerminal(page);
    const box = await page.locator(".xterm-screen").boundingBox();
    const y = box.y + box.height / 2;
    await nativeSwipe(page, { x: box.x + 40, y }, { x: box.x + box.width - 40, y });
    await flushInput(page, input);
    expect(input).toEqual(["x"]);
  });

  test("two-finger pinch zooms the page without terminal input", async ({ page }) => {
    const { input } = await mobileTerminal(page);
    const box = await page.locator(".xterm-screen").boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + 200;
    const points = (distance) => [
      { x: x - distance, y, id: 1 },
      { x: x + distance, y, id: 2 },
    ];
    const before = await page.evaluate(() => window.visualViewport.scale);
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points(25),
    });
    for (let distance = 30; distance <= 100; distance += 5) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(distance),
      });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await client.detach();
    await expect
      .poll(() => page.evaluate(() => window.visualViewport.scale))
      .toBeGreaterThan(before);
    const moves = await page.evaluate(() => window.touchMoves);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((prevented) => !prevented)).toBe(true);
    await flushInput(page, input);
    expect(input).toEqual(["x"]);
  });
});
