import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const chat = baseURL + "/agents/home/chats/dinner";
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test.describe("agent chat header", () => {
  test("phone shows one 56px bar instead of the app header", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const header = page.locator(".assistant-header");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Home assistant");
    await expect(page.locator(".mobile-header")).toBeHidden();
    await expect(page.locator(".assistant-breadcrumb, .assistant-view-tabs")).toHaveCount(
      0,
    );
    const status = header.locator(".assistant-header-status");
    await expect(status).toHaveClass(/\bready\b/);
    await expect(status).toContainText("Ready");
    await expect(status).toContainText("· openai/gpt-4.1-mini");
    await expect(status.locator(".assistant-header-dot")).toHaveCSS(
      "background-color",
      "rgb(134, 184, 142)",
    );
    expect(Math.round((await header.boundingBox()).height)).toBe(56);
    await header.getByRole("button", { name: "Agent settings", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/home\/settings$/);
    await expect(page.locator(".assistant-header-sub")).toHaveText("Settings");
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
  });

  test("header menu opens the drawer and Escape returns focus to it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const menu = page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
    await expect(menu).toBeFocused();
  });

  test("closing the drawer by the backdrop forgets the menu as focus target", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const menu = page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true });
    await menu.click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await page.mouse.click(385, 420);
    await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
    const field = page.locator(".assistant-composer textarea");
    await field.focus();
    // Another opener that does not record itself (the app header's own button).
    await page.evaluate(() =>
      document.querySelector(".mobile-header .icon-button").click(),
    );
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
    await expect(menu).not.toBeFocused();
    await expect(field).toBeFocused();
  });

  test("settings without a connection still reach the drawer and the agent list", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      models: [{ id: "other", name: "Other", available: true }],
    });
    await page.goto(baseURL + "/agents/home/settings");
    await expect(page.locator(".assistant-header-status")).toHaveText(
      "Provider connection missing",
    );
    await expect(page.locator(".assistant-notice").first()).toContainText(
      "provider connection was deleted",
    );
    await page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
  });

  test("a collapsed desktop sidebar does not cover the header", async ({ page }) => {
    await chatFixture(page);
    await page.goto(chat);
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    const [float, avatar, header] = await Promise.all([
      page.locator(".sidebar-float").boundingBox(),
      page.locator(".assistant-header .assistant-avatar").boundingBox(),
      page.locator(".assistant-header").boundingBox(),
    ]);
    expect(avatar.x).toBeGreaterThanOrEqual(float.x + float.width);
    expect(header.y).toBe(0);
    expect(Math.round(header.height)).toBe(68);
  });

  for (const language of ["de", "en"])
    test(`320px phone keeps long header copy inside the bar (${language})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await chatFixture(page, {
        language,
        assistants: [
          chatAssistant({
            name: "Chief of Staff with a long agent name",
            model: {
              connectionId: "router",
              modelId: "anthropic/claude-sonnet-4.5-long",
            },
          }),
        ],
        activity: {
          home: {
            state: "waiting",
            reason: "approval",
            label: "teamActive.awaiting",
            pendingApprovals: 1,
            team: "awaiting",
          },
        },
      });
      await page.goto(chat);
      const status = page.locator(".assistant-header-status");
      await expect(status).toContainText(
        language === "en" ? "Team awaiting approval" : "Team wartet auf Freigabe",
      );
      const [label, gear] = await Promise.all([
        status.boundingBox(),
        page.locator(".assistant-header-settings").boundingBox(),
      ]);
      expect(label.x + label.width).toBeLessThanOrEqual(gear.x + 1);
      expect(gear.x + gear.width).toBeLessThanOrEqual(320);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
});

const working = {
  messages: [{ id: "q", role: "user", text: "Plan my week" }],
  requests: [
    {
      id: "r",
      text: "Plan my week",
      state: "accepted",
      attempt: { id: "a1", state: "accepted" },
    },
  ],
  stale: false,
};

test.describe("agent chat transcript", () => {
  test("replies are flat and the user bubble hides its name visually", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const reply = page.locator(".assistant-message.assistant").first();
    await expect(reply).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(reply).toHaveCSS("border-top-width", "0px");
    await expect(reply).toHaveCSS("font-size", "15px");
    const user = page.locator(".assistant-message.user").first();
    await expect(user.locator("strong")).toHaveText("You");
    expect(
      await user.locator("strong").evaluate((e) => e.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(1);
    await expect(user).toHaveCSS("border-bottom-right-radius", "4px");
    const [u, a] = [await user.boundingBox(), await reply.boundingBox()];
    expect(a.width).toBeGreaterThan(350);
    expect(u.x + u.width).toBeGreaterThan(370);
  });

  test("streaming shows a block cursor and an accent working note", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, { history: working });
    await page.goto(chat);
    // The chat listens for events once it is open; its loaded history shows that.
    await expect(page.locator(".assistant-run-state.working")).toBeVisible();
    await emit(page, {
      type: "delta",
      conversationId: "dinner",
      text: "Here is a draft",
    });
    const streaming = page.locator(".assistant-message.streaming");
    await expect(streaming).toContainText("Here is a draft");
    expect(
      await streaming
        .locator(".message-content > :last-child")
        .evaluate((e) => getComputedStyle(e, "::after").width),
    ).toBe("8px");
    const note = page.locator(".assistant-run-state.working");
    await expect(note).toContainText("Accepted");
    await expect(note).toHaveCSS("color", "rgb(255, 201, 157)");
    const gap = await page
      .locator(".assistant-transcript")
      .evaluate(
        (e) =>
          e.getBoundingClientRect().bottom -
          e.querySelector(".assistant-run-state").getBoundingClientRect().bottom,
      );
    expect(gap).toBeLessThan(40);
  });

  test("an optimistic request renders as a user bubble", async ({ page }) => {
    await chatFixture(page, {
      history: { ...working, messages: [] },
    });
    await page.goto(chat);
    const bubble = page
      .locator(".assistant-message.user")
      .filter({ hasText: "Plan my week" });
    await expect(bubble).toHaveCount(1);
    await expect(bubble.locator("strong")).toHaveClass(/sr-only/);
  });

  test("desktop centres the transcript at 760px", async ({ page }) => {
    // The tablet project runs every spec on a touch 820 px screen.
    test.skip(test.info().project.name === "tablet", "desktop-only layout");
    await chatFixture(page);
    await page.goto(chat);
    const reply = await page
      .locator(".assistant-message.assistant")
      .first()
      .boundingBox();
    expect(Math.round(reply.width)).toBe(760);
  });
});

test.describe("agent chat transcript layout details", () => {
  const cursor = (page) =>
    page
      .locator(".assistant-message.streaming .message-content > :last-child")
      .evaluate((e) => getComputedStyle(e, "::after").animationName);
  const stream = async (page) => {
    await chatFixture(page, { history: working });
    await page.goto(chat);
    await expect(page.locator(".assistant-run-state.working")).toBeVisible();
    await emit(page, { type: "delta", conversationId: "dinner", text: "Draft" });
    await expect(page.locator(".assistant-message.streaming")).toBeVisible();
  };

  test("the streaming cursor blinks unless motion is reduced", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await stream(page);
    expect(await cursor(page)).not.toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await cursor(page)).toBe("none");
  });

  test("the log comes before team and approval cards", async ({ page }) => {
    const task = (extra) => ({
      id: "a1",
      state: "awaiting_approval",
      revision: 1,
      projectName: "Site",
      payload: { action: "coding_start", task: "Fix it" },
      ...extra,
    });
    await chatFixture(page, {
      teams: [
        {
          id: "team",
          kind: "team",
          parentAssistantId: "home",
          objective: "Review",
          phase: "awaiting_approval",
          members: [{ name: "Reviewer", role: "Review", assignment: "Check it" }],
          memberIds: [],
          revision: 1,
        },
      ],
      actions: [task()],
    });
    await page.goto(chat);
    await expect(page.locator(".assistant-action-approvals")).toBeVisible();
    const order = await page
      .locator(".assistant-transcript")
      .evaluate((root) =>
        [...root.children]
          .map((c) =>
            c.matches('[role="log"]')
              ? "log"
              : c.matches(".assistant-team-approvals")
                ? "teams"
                : c.matches(".assistant-action-approvals")
                  ? "approvals"
                  : "",
          )
          .filter(Boolean),
      );
    expect(order).toEqual(["log", "teams", "approvals"]);
  });

  test("internal events are centred in the transcript", async ({ page }) => {
    await chatFixture(page, {
      history: {
        messages: [
          { id: "q", role: "user", text: "Go" },
          { id: "e", role: "event", event: "team-result" },
        ],
        requests: [],
        stale: false,
      },
    });
    await page.goto(chat);
    const event = page.locator(".assistant-event");
    await expect(event).toHaveCSS("text-align", "center");
    const [e, t] = [
      await event.boundingBox(),
      await page.locator(".assistant-transcript").boundingBox(),
    ];
    expect(Math.abs(e.x + e.width / 2 - (t.x + t.width / 2))).toBeLessThan(2);
  });

  for (const width of [390, 1440]) {
    test(`a short conversation sits at the bottom (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await chatFixture(page);
      await page.goto(chat);
      const messages = page.locator(".assistant-message");
      await expect(messages).toHaveCount(2);
      const t = await page.locator(".assistant-transcript").boundingBox();
      const first = await messages.first().boundingBox();
      const last = await messages.last().boundingBox();
      expect(first.y - t.y).toBeGreaterThan(200);
      expect(t.y + t.height - (last.y + last.height)).toBeLessThan(40);
    });
  }

  test("phones use 16px padding and 85% user bubbles", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      history: {
        messages: [{ id: "q", role: "user", text: "word ".repeat(80) }],
        requests: [],
        stale: false,
      },
    });
    await page.goto(chat);
    await expect(page.locator(".assistant-transcript")).toHaveCSS("padding-left", "16px");
    const log = await page.locator('.assistant-transcript > [role="log"]').boundingBox();
    const bubble = await page.locator(".assistant-message.user").boundingBox();
    expect(Math.abs(bubble.width - log.width * 0.85)).toBeLessThan(2);
  });
});

test.describe("agent chat composer", () => {
  test("options hold files, the team switch and the hint; the chip shows the choice", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await chatFixture(page);
    await page.goto(chat);
    const options = page.getByRole("button", { name: "Options", exact: true });
    await expect(options).toHaveAttribute("aria-expanded", "false");
    await options.click();
    await expect(
      page.getByRole("button", { name: "Attach file, image or video" }),
    ).toBeFocused();
    const toggle = page.getByRole("switch", { name: "Allow a team for this message" });
    await expect(page.locator(".assistant-options-hint")).toBeVisible();
    await toggle.check();
    await expect(
      page.getByRole("button", { name: "Close options", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".assistant-options")).toBeHidden();
    await expect(options).toBeFocused();
    const chip = page.getByRole("button", { name: "Team allowed", exact: true });
    await expect(chip).toBeVisible();
    await options.click();
    await page.locator(".assistant-transcript").click({ position: { x: 20, y: 20 } });
    await expect(page.locator(".assistant-options")).toBeHidden();
    await page.getByLabel("Message", { exact: true }).fill("Review the project");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => state.posted[0]?.teamAllowed).toBe(true);
    await expect(chip).toHaveCount(0);
  });

  test("a working request swaps send for Stop and keeps the draft", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await chatFixture(page, { history: working });
    await page.goto(chat);
    const stop = page.getByRole("button", { name: "Stop response", exact: true });
    await expect(stop).toHaveText("Stop");
    await expect(stop.locator("svg")).toHaveAttribute("fill", "currentColor");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Next idea while it works");
    await stop.click();
    await expect.poll(() => state.calls).toContain("/api/assistant-attempts/a1/cancel");
    await expect(input).toHaveValue("Next idea while it works");
  });

  test("the message field grows up to six lines", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const input = page.getByLabel("Message", { exact: true });
    const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
    const one = (await input.boundingBox()).height;
    await input.fill(lines(3));
    expect((await input.boundingBox()).height).toBeGreaterThan(one + 30);
    await input.fill(lines(12));
    expect((await input.boundingBox()).height).toBeLessThanOrEqual(133);
  });

  test("desktop shows the hint inline and centres the composer", async ({ page }) => {
    // The tablet project runs every spec on a touch 820 px screen.
    test.skip(test.info().project.name === "tablet", "desktop-only layout");
    await chatFixture(page);
    await page.goto(chat);
    await expect(page.locator(".assistant-composer-hint")).toHaveText(
      "Enter: send · Shift + Enter: new line",
    );
    const box = await page.locator(".assistant-composer-box").boundingBox();
    expect(Math.round(box.width)).toBe(760);
  });

  test("Escape closes the options before the drawer, and only then the drawer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const sidebar = page.locator(".sidebar");
    await page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await expect(sidebar).toHaveClass(/\bopen\b/);
    // The drawer covers the composer, so reach the button by keyboard.
    await page.getByRole("button", { name: "Options", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".assistant-options")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".assistant-options")).toBeHidden();
    await expect(sidebar).toHaveClass(/\bopen\b/);
    await expect(
      page.getByRole("button", { name: "Options", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebar).not.toHaveClass(/\bopen\b/);
  });

  test("Escape in the message field with closed options still closes the drawer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    await page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page.getByLabel("Message", { exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
  });

  test("draft and team permission survive switching conversations", async ({ page }) => {
    await chatFixture(page, {
      conversations: [
        { id: "dinner", assistantId: "home" },
        { id: "lunch", assistantId: "home" },
      ],
    });
    await page.goto(chat);
    await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("switch", { name: "Allow a team for this message" }).check();
    await page.evaluate(() => {
      history.pushState({}, "", "/agents/home/chats/lunch");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Team allowed", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => {
      history.pushState({}, "", "/agents/home/chats/dinner");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Keep this draft",
    );
    await expect(
      page.getByRole("button", { name: "Team allowed", exact: true }),
    ).toBeVisible();
  });

  test("the field returns to one row after a successful send", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await chatFixture(page);
    await page.goto(chat);
    const input = page.getByLabel("Message", { exact: true });
    const one = (await input.boundingBox()).height;
    await input.fill("a\nb\nc\nd");
    expect((await input.boundingBox()).height).toBeGreaterThan(one + 30);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => state.posted.length).toBe(1);
    await expect(input).toHaveValue("");
    await expect
      .poll(async () => (await input.boundingBox()).height)
      .toBeLessThan(one + 2);
  });
});

test.describe("team member composer", () => {
  const member = {
    assistants: [
      chatAssistant(),
      chatAssistant({ id: "worker", name: "Worker", teamMemberId: "m1" }),
    ],
    conversations: [{ id: "dinner", assistantId: "worker" }],
  };
  const memberChat = baseURL + "/agents/worker/chats/dinner";

  test("one row with only the files option, no hint and the member placeholder", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      ...member,
      members: [{ id: "m1", assistantId: "worker", phase: "ready" }],
    });
    await page.goto(memberChat);
    const input = page.getByLabel("Message", { exact: true });
    await expect(input).toHaveAttribute("placeholder", "Message Worker …");
    const options = page.getByRole("button", { name: "Options", exact: true });
    await expect(page.locator(".assistant-composer-hint")).toHaveCount(0);
    const [o, f, b] = [
      await options.boundingBox(),
      await input.boundingBox(),
      await page.getByRole("button", { name: "Send", exact: true }).boundingBox(),
    ];
    expect(Math.abs(f.y + f.height / 2 - (b.y + b.height / 2))).toBeLessThan(6);
    expect(Math.abs(f.y + f.height / 2 - (o.y + o.height / 2))).toBeLessThan(6);
    expect(f.x).toBeGreaterThan(o.x + o.width - 2);
    expect(b.x).toBeGreaterThan(f.x + f.width - 2);
    await options.click();
    await expect(page.locator(".assistant-options-row")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Attach file, image or video" }),
    ).toBeVisible();
    await expect(page.locator(".assistant-options-hint")).toHaveCount(0);
  });

  test("send stays disabled while the member is busy", async ({ page }) => {
    await chatFixture(page, {
      ...member,
      members: [{ id: "m1", assistantId: "worker", phase: "running" }],
    });
    await page.goto(memberChat);
    await page.getByLabel("Message", { exact: true }).fill("Hello");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  });
});
