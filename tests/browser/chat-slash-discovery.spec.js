import { test, expect } from "@playwright/test";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

const discovered = [
  {
    name: "superpowers:brainstorming",
    kind: "skill",
    scope: "plugin",
    plugin: "superpowers",
    description: "Use this before any creative work, such as creating features",
  },
  {
    name: "deploy",
    kind: "command",
    scope: "user",
    description: "Deploy the app to an environment",
    argumentHint: "[env] [tag]",
  },
  { name: "ship", kind: "skill", scope: "project", description: "Ship it" },
];

async function fixture(page, { fail = false } = {}) {
  const session = {
    id: "commands",
    accountId: "fixture",
    tool: "claude",
    cwd: "/fixture",
    status: "running",
    name: "Command discovery",
  };
  const data = {
    availability: "ready",
    messages: [{ id: "hello", role: "assistant", text: "Ready when you are." }],
    tasks: [],
  };
  const inputs = [];
  let discoveries = 0;
  await mockChatStream(page, () => data);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/chat/slash-commands")) {
      discoveries++;
      if (fail) return route.fulfill({ status: 500, json: { error: "unavailable" } });
      return route.fulfill({ json: { tool: "claude", commands: discovered } });
    }
    let result = {};
    if (pathname === "/api/state")
      result = {
        sessions: [session],
        accounts: [],
        tools: [{ id: "claude", name: "claude", installed: true }],
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
  return {
    input: page.locator(".chat-composer textarea"),
    inputs,
    discoveries: () => discoveries,
  };
}

test("discovered commands show their hint, source and description and filter as you type", async ({
  page,
}) => {
  const { input, inputs, discoveries } = await fixture(page);
  // Nothing is read before the draft starts with a slash.
  await input.fill("hello");
  expect(discoveries()).toBe(0);
  await input.fill("/dep");
  const deploy = page.locator(".chat-slash-options button", { hasText: "/deploy" });
  await expect(deploy).toBeVisible();
  await expect(deploy.locator(".chat-slash-hint")).toHaveText("[env] [tag]");
  await expect(deploy.locator("small")).toHaveText("Deploy the app to an environment");
  // The last part of a plugin command matches too.
  await input.fill("/brain");
  const skill = page.locator(".chat-slash-options button").first();
  await expect(skill.locator(".chat-slash-name")).toHaveText(
    "/superpowers:brainstorming",
  );
  await expect(skill.locator(".chat-slash-source")).toHaveText("superpowers");
  await input.fill("/sh");
  await expect(
    page
      .locator(".chat-slash-options button", { hasText: "/ship" })
      .locator(".chat-slash-source"),
  ).toHaveText("Project");
  // Built-ins stay available next to the discovered commands.
  await input.fill("/comp");
  await expect(page.getByRole("option", { name: "/compact", exact: true })).toBeVisible();
  await input.fill("/brain");
  await input.press("Tab");
  await expect(input).toHaveValue("/superpowers:brainstorming ");
  expect(inputs).toHaveLength(0);
  expect(discoveries()).toBe(1);
});

test("a failed discovery falls back to the built-in commands and says so", async ({
  page,
}) => {
  const { input } = await fixture(page, { fail: true });
  await input.fill("/mo");
  await expect(page.getByRole("option", { name: "/model", exact: true })).toBeVisible();
  await expect(page.locator(".chat-slash-note")).toHaveText(
    "Built-in commands only: custom commands could not be read.",
  );
  await expect(
    page.locator(".chat-slash-options button", { hasText: "/deploy" }),
  ).toHaveCount(0);
});

test.describe("touch", () => {
  test.use({ hasTouch: true });
  test("long discovered entries fit a 390 px wide phone and can be tapped", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    const { input, inputs } = await fixture(page);
    await input.fill("/d");
    const popup = page.locator(".chat-slash-popup");
    await expect(popup).toBeVisible();
    const deploy = page.locator(".chat-slash-options button", { hasText: "/deploy" });
    await expect(deploy).toBeVisible();
    for (const box of [await popup.boundingBox(), await deploy.boundingBox()]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await deploy.tap();
    await expect(input).toHaveValue("/deploy ");
    expect(inputs).toHaveLength(0);
  });
});
