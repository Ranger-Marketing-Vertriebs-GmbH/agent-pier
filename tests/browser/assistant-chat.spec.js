import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const filler = Array.from({ length: 24 }, (_, n) => ({
  id: `filler-${n}`,
  role: n % 2 ? "user" : "assistant",
  text: `Earlier message ${n} with enough words to take up a couple of lines in the transcript view.`,
}));

async function setup(page, { messages = filler, member = null } = {}) {
  await fixture(page);
  await page.addInitScript(() => {
    localStorage.setItem("agentpier-language", "en");
    const Native = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (url !== "/api/assistant-events") return new Native(url);
        window.assistantTestStream = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    };
  });
  const assistant = {
    id: "home",
    name: "Home assistant",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 1,
    effectiveRevision: 1,
  };
  const state = { messages: [...messages], posted: [] };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const url = new URL(route.request().url());
    const method = route.request().method();
    const p = url.pathname;
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(p)
    )
      return route.fallback();
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants: [assistant],
        conversations: [{ id: "dinner", assistantId: "home" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        members: member ? [member] : [],
      };
    else if (p === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) {
      if (method === "POST") state.posted.push(route.request().postDataJSON());
      body = { messages: state.messages, requests: [], stale: false };
    } else if (p.endsWith("/conversations")) body = { id: "dinner", assistantId: "home" };
    else if (p === "/api/assistants/home") body = assistant;
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  return state;
}

const transcript = (page) => page.locator(".assistant-transcript");
const gap = (page) =>
  transcript(page).evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight);
const emit = (page, event) =>
  page.evaluate((event) => {
    window.assistantTestStream.onmessage({ data: JSON.stringify(event) });
  }, event);

for (const [name, size, touch] of [
  ["desktop", { width: 1440, height: 1000 }, false],
  ["tablet", { width: 820, height: 1180 }, true],
  ["phone", { width: 390, height: 844 }, true],
]) {
  test.describe(name, () => {
    test.use({ viewport: size, hasTouch: touch, isMobile: touch });

    test("model output renders safely with GFM", async ({ page }) => {
      const remote = [];
      page.on("request", (request) => {
        if (request.url().includes("evil.example")) remote.push(request.url());
      });
      await setup(page, {
        messages: [
          {
            id: "m1",
            role: "assistant",
            text: [
              "![x](https://evil.example/a.png)",
              "",
              "[docs](https://example.com/docs) <b>raw</b>",
              "",
              "| a | b |",
              "| - | - |",
              "| one | two |",
            ].join("\n"),
          },
        ],
      });
      const message = page.locator(".assistant-message.assistant");
      await expect(message.locator("img")).toHaveCount(0);
      await expect(message).toContainText("[Image: x]");
      const link = message.getByRole("link", { name: "docs" });
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
      await expect(link).toHaveAttribute("rel", /noreferrer/);
      await expect(message.locator("table td").first()).toHaveText("one");
      await expect(message.locator("b")).toHaveCount(0);
      await page.waitForTimeout(300);
      expect(remote).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `.cache/assistant-chat-${name}-en.png` });
    });

    test("streaming stays pinned unless the reader scrolled up", async ({ page }) => {
      await setup(page);
      await expect.poll(() => gap(page)).toBeLessThan(5);
      const long = (n) =>
        Array.from({ length: n }, (_, i) => `Streaming line ${i}`).join("\n\n");
      await emit(page, { type: "delta", conversationId: "dinner", text: long(20) });
      await expect(page.getByText("Streaming line 19")).toBeAttached();
      await expect.poll(() => gap(page)).toBeLessThan(5);
      await transcript(page).evaluate((e) => (e.scrollTop = 0));
      await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
      await emit(page, { type: "delta", conversationId: "dinner", text: long(40) });
      await expect(page.getByText("Streaming line 39")).toBeAttached();
      expect(await transcript(page).evaluate((e) => e.scrollTop)).toBeLessThan(5);
      await page.getByRole("button", { name: "Jump to latest" }).click();
      await expect.poll(() => gap(page)).toBeLessThan(5);
    });

    test("Enter behaves like the session chat", async ({ page }) => {
      const state = await setup(page);
      const input = page.getByLabel("Message", { exact: true });
      await input.fill("first");
      await input.press("Shift+Enter");
      await input.pressSequentially("second");
      await expect(input).toHaveValue("first\nsecond");
      expect(state.posted).toHaveLength(0);
      await input.press("Enter");
      if (touch) {
        await expect(input).toHaveValue("first\nsecond\n");
        expect(state.posted).toHaveLength(0);
        await expect(page.getByText("Use the button to send")).toBeVisible();
      } else {
        await expect.poll(() => state.posted.length).toBe(1);
        expect(state.posted[0].text).toBe("first\nsecond");
        await expect(input).toHaveValue("");
        await expect(page.getByText("Enter: send")).toBeVisible();
      }
    });

    test("only replies finished after load are announced, as plain text", async ({
      page,
    }) => {
      const state = await setup(page);
      const live = page.locator("[aria-live='polite']");
      await expect(live).toHaveCount(1);
      await expect(page.locator(".assistant-message").last()).toBeVisible();
      await expect(live).toHaveText("");
      await emit(page, { type: "delta", conversationId: "dinner", text: "typing now" });
      await expect(page.locator(".assistant-message.assistant").last()).toContainText(
        "typing now",
      );
      await expect(live).toHaveText("");
      state.messages.push({
        id: "done",
        role: "assistant",
        text: "**Dinner** is [ready](https://example.com)",
      });
      await emit(page, { type: "change" });
      await expect(live).toHaveText("Dinner is ready");
      expect(await live.locator(".assistant-teams, .assistant-team-panel").count()).toBe(
        0,
      );
    });

    test("header shows the member state while it works", async ({ page }) => {
      await setup(page, {
        member: {
          id: "home",
          assistantId: "home",
          parentAssistantId: "parent",
          role: "Research",
          phase: "running",
        },
      });
      const badge = page.locator(".assistant-state-badge");
      await expect(badge).toHaveText("Working");
      await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);
    });
  });
}

test.describe("iPad keyboard", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
  test("composer stays above the keyboard", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        value: 700,
      });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    const input = page.getByLabel("Message", { exact: true });
    await expect
      .poll(async () => {
        const box = await input.boundingBox();
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(700);
    const box = await input.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    await expect.poll(() => gap(page)).toBeLessThan(5);
    await page.screenshot({ path: ".cache/assistant-chat-ipad-keyboard-en.png" });
  });
});

test("coding run notes show the outcome with a link to the run", async ({ page }) => {
  await setup(page, {
    messages: [
      { id: "m1", role: "user", text: "Fix the tests", timestamp: 1 },
      {
        id: "coding-run:a:started",
        role: "event",
        event: "coding-run",
        phase: "started",
        state: "running",
        runId: "run-7",
        pipelineName: "Build",
        projectName: "App",
        timestamp: 2,
      },
      {
        id: "coding-run:a:result",
        role: "event",
        event: "coding-run",
        phase: "result",
        state: "failed",
        runId: "run-7",
        pipelineName: "Build",
        projectName: "App",
        memberName: "Ada",
        timestamp: 3,
      },
    ],
  });
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log.getByText("Coding run started: Build · App")).toBeVisible();
  await expect(
    log.getByText("Coding run requested by Ada failed: Build · App"),
  ).toBeVisible();
  await expect(log.locator(".assistant-message.user")).toHaveCount(1);
  const link = log.getByRole("link", { name: "Open run and artifacts" }).last();
  await expect(link).toHaveAttribute("href", "/pipelines/runs/run-7");
  await link.click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/run-7$/);
});
