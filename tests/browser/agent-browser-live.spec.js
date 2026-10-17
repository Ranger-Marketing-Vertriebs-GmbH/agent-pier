import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const home = {
  id: "home",
  name: "Home",
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { browser: true },
  browserRunning: true,
};
// A real 1x1 JPEG, so a test sees whether the browser may decode the picture.
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////" +
    "////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAA" +
    "AAAAAP/aAAgBAQABPxA=",
  "base64",
);
// One frame as OpenClaw sends it: header length, JSON header, JPEG bytes.
function frame() {
  const header = Buffer.from(
    JSON.stringify({ url: "https://shop.example/", cssWidth: 800 }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, jpeg]);
}
// The picture loaded and decoded (the page's CSP allows blob: images).
const decoded = (picture) =>
  expect
    .poll(() => picture.evaluate((img) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
const tabs = [
  { targetId: "t1", title: "Shop", url: "https://shop.example/" },
  { targetId: "t2", title: "Cart", url: "https://shop.example/cart" },
];

async function setup(page, { status = "live", refuse = false, control } = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [home],
          conversations: [
            {
              id: "c1",
              assistantId: "home",
              runtimeSessionKey: "k",
              channel: "agentpier",
            },
          ],
          models: [{ id: "router", name: "Router", available: true }],
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({
        json: {
          availability: "ready",
          sync: "current",
          browser: {
            available: true,
            name: "Chrome for Testing",
            visible: { available: true },
          },
        },
      });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages: [], requests: [] } });
    return route.fulfill({ json: {} });
  });
  const commands = [];
  commands.connects = 0;
  await page.routeWebSocket("**/api/assistants/home/browser-stream*", (ws) => {
    commands.connects++;
    const state = (control) =>
      ws.send(
        JSON.stringify({
          type: "state",
          state: {
            status,
            url: "https://shop.example/",
            title: "Shop",
            targetId: "t1",
            tabs,
            control,
          },
        }),
      );
    ws.onMessage((message) => {
      const command = JSON.parse(message);
      commands.push(command);
      // The server's answer to a takeover and a hand-back.
      if (command.type === "take") state({ held: true, mine: true, warning: false });
      if (command.type === "handBack") state({ held: false, mine: false });
    });
    state(control || { held: false, mine: false });
    if (status === "live") ws.send(frame());
    if (refuse) ws.close({ code: 1008 });
  });
  return commands;
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the live view shows the agent's browser, its address and tabs", async ({
      page,
    }) => {
      const commands = await setup(page);
      await page.goto(baseURL + "/agents/home/browser");
      await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
      await expect(
        page.getByText("https://shop.example/", { exact: true }),
      ).toBeVisible();
      const picture = page.getByRole("img", { name: "Live view of Home's browser" });
      await expect(picture).toHaveAttribute("src", /^blob:/);
      await decoded(picture);
      await page.getByLabel("Tab").selectOption("t2");
      await expect
        .poll(() => commands)
        .toContainEqual({ type: "select", targetId: "t2" });
      await expect(page.getByText("AgentPier stores no pictures")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });

    test("a stopped browser can be started from the live view", async ({ page }) => {
      const commands = await setup(page, { status: "stopped" });
      await page.goto(baseURL + "/agents/home/browser");
      await expect(page.getByText("The browser is not running.").first()).toBeVisible();
      await page.getByRole("button", { name: "Start browser" }).click();
      await expect.poll(() => commands).toContainEqual({ type: "start" });
    });
  });
}

test("the agent settings open the live view", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/settings?tab=capabilities");
  await page.getByRole("link", { name: /Open live view/ }).click();
  await expect(page).toHaveURL(/\/agents\/home\/browser$/);
  await expect(
    page.getByRole("img", { name: "Live view of Home's browser" }),
  ).toBeVisible();
});

test("the chat header shows a live preview while the browser runs", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/chats/c1");
  const preview = page.getByRole("link", { name: "Live view of Home's browser" });
  await expect(preview).toBeVisible();
  await expect(preview.locator("img")).toHaveAttribute("src", /^blob:/);
  await decoded(preview.locator("img"));
  await preview.click();
  await expect(page).toHaveURL(/\/agents\/home\/browser$/);
});

test("a live view the server ended says so and does not reconnect", async ({ page }) => {
  const commands = await setup(page, { refuse: true });
  await page.goto(baseURL + "/agents/home/browser");
  await expect(page.getByText("The live view ended.")).toBeVisible();
  await page.waitForTimeout(2500);
  expect(commands.connects).toBe(1);
});

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(`${label} takeover`, () => {
    test.use(use);

    test("the owner takes over, clicks and types, then hands back", async ({ page }) => {
      const commands = await setup(page);
      await page.goto(baseURL + "/agents/home/browser");
      await page.getByRole("button", { name: "Take over", exact: true }).click();
      await expect(page.getByText("You control the browser.")).toBeVisible();
      const picture = page.getByRole("img", { name: "Live view of Home's browser" });
      const box = await picture.boundingBox();
      if (label === "phone")
        await picture.tap({ position: { x: box.width / 2, y: box.height / 4 } });
      else await picture.click({ position: { x: box.width / 2, y: box.height / 4 } });
      await expect
        .poll(
          () =>
            commands.filter((c) => c.type === "pointer" && c.action === "down").length,
        )
        .toBe(1);
      const down = commands.find((c) => c.type === "pointer" && c.action === "down");
      expect(down.x).toBeCloseTo(0.5, 1);
      expect(down.y).toBeCloseTo(0.25, 1);
      expect(down.button).toBe("left");
      expect(commands.some((c) => c.type === "pointer" && c.action === "up")).toBe(true);
      // Typing goes to the hidden keyboard field: text as text, Enter as a key.
      await page.keyboard.type("Max");
      await page.keyboard.press("Enter");
      await expect
        .poll(() =>
          commands
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(""),
        )
        .toBe("Max");
      await expect
        .poll(() =>
          commands.some(
            (c) => c.type === "key" && c.key === "Enter" && c.action === "down",
          ),
        )
        .toBe(true);
      // Shift+Escape leaves the browser for the takeover bar.
      await page.keyboard.press("Shift+Escape");
      await expect(page.getByRole("button", { name: "Hand back" })).toBeFocused();
      expect(commands.some((c) => c.type === "key" && c.key === "Escape")).toBe(false);
      if (label === "phone") {
        // A one-finger drag scrolls the page; it never clicks.
        const pointer = (type, y) =>
          picture.dispatchEvent(type, {
            pointerType: "touch",
            pointerId: 7,
            isPrimary: true,
            clientX: box.x + box.width / 2,
            clientY: box.y + y,
            bubbles: true,
          });
        const downs = commands.filter((c) => c.type === "pointer").length;
        await pointer("pointerdown", 200);
        await pointer("pointermove", 150);
        await pointer("pointermove", 100);
        await pointer("pointerup", 100);
        await expect
          .poll(() => commands.filter((c) => c.type === "wheel").length)
          .toBeGreaterThan(0);
        expect(commands.find((c) => c.type === "wheel").deltaY).toBeGreaterThan(0);
        expect(commands.filter((c) => c.type === "pointer").length).toBe(downs);
        // An Android keyboard's Backspace arrives as beforeinput, not as a key.
        await page.getByLabel("Keyboard input for the agent browser").evaluate((field) =>
          field.dispatchEvent(
            new InputEvent("beforeinput", {
              inputType: "deleteContentBackward",
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        await expect
          .poll(() => commands.some((c) => c.type === "key" && c.key === "Backspace"))
          .toBe(true);
      }
      await page.getByRole("button", { name: "Hand back" }).click();
      await expect.poll(() => commands.at(-1)).toEqual({ type: "handBack" });
      await expect(
        page.getByRole("button", { name: "Take over", exact: true }),
      ).toBeVisible();
    });
  });
}

test("the chat preview's Take over opens the live view taking control", async ({
  page,
}) => {
  const commands = await setup(page);
  await page.goto(baseURL + "/agents/home/chats/c1");
  await page.getByRole("link", { name: "Take over" }).click();
  await expect.poll(() => commands.some((c) => c.type === "take")).toBe(true);
  await expect(page.getByText("You control the browser.")).toBeVisible();
  // Taken over: the address drops ?takeover=1, so a reload only watches.
  await expect(page).toHaveURL(/\/agents\/home\/browser$/);
});

test("the owner's other device holds control: take over here moves it", async ({
  page,
}) => {
  const commands = await setup(page, { control: { held: true, mine: false } });
  await page.goto(baseURL + "/agents/home/browser");
  await expect(
    page.getByText("You are controlling this browser on another device."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Take over here" }).click();
  await expect.poll(() => commands.at(-1)).toEqual({ type: "take", move: true });
});
