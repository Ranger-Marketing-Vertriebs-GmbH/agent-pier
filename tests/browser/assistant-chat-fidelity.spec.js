import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// Measurements from the design handoff (states 1d, 2a, 2c) that the agent chat keeps.
const chat = baseURL + "/agents/home/chats/dinner";

test.describe("agent chat handoff measurements", () => {
  for (const [state, note] of [
    ["completed", 16],
    ["running", 12],
  ])
    test(`phones space turns 20px apart and the ${state} note ${note}px under the reply`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await chatFixture(page, {
        history: {
          messages: [
            { id: "q", role: "user", text: "Plan the week" },
            { id: "a", role: "assistant", text: "Here is a first draft." },
          ],
          requests: [
            { id: "r", text: "Plan the week", state, attempt: { id: "t", state } },
          ],
          stale: false,
        },
      });
      await page.goto(chat);
      const user = await page.locator(".assistant-message.user").boundingBox();
      const reply = await page.locator(".assistant-message.assistant").boundingBox();
      const run = await page.locator(".assistant-run-state").boundingBox();
      expect(Math.round(reply.y - (user.y + user.height))).toBe(20);
      expect(Math.round(run.y - (reply.y + reply.height))).toBe(note);
      expect(run.height).toBe(16);
    });

  test("a long phone transcript starts 16px below the bar and cards sit 14px apart", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      history: {
        messages: Array.from({ length: 20 }, (_, n) => ({
          id: `m${n}`,
          role: n % 2 ? "assistant" : "user",
          text: `Message ${n} with enough words to wrap across a couple of lines.`,
        })),
        requests: [],
        stale: false,
      },
      teams: [
        {
          id: "team",
          revision: 1,
          parentAssistantId: "home",
          parentConversationId: "dinner",
          objective: "Prepare the relaunch",
          phase: "awaiting_approval",
          members: [{ name: "Planner", role: "Plan", assignment: "Plan the launch" }],
          memberIds: [],
        },
      ],
    });
    await page.goto(chat);
    const transcript = page.locator(".assistant-transcript");
    await transcript.evaluate((e) => (e.scrollTop = 0));
    const [t, first] = [
      await transcript.boundingBox(),
      await page.locator(".assistant-message").first().boundingBox(),
    ];
    expect(Math.round(first.y - t.y)).toBe(16);
    await transcript.evaluate((e) => (e.scrollTop = e.scrollHeight));
    const last = await page.locator(".assistant-message").last().boundingBox();
    const card = await page.locator(".assistant-team-card").boundingBox();
    expect(Math.round(card.y - (last.y + last.height))).toBe(14);
  });

  test("the options popover holds 52px rows for files and the switch above the composer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    await page.getByRole("button", { name: "Options", exact: true }).click();
    const box = async (selector) => page.locator(selector).boundingBox();
    const attach = await box("button.assistant-options-row");
    expect(attach.height).toBe(52);
    const switchRow = "label.assistant-options-row";
    const row = await box(switchRow);
    const icon = await box(`${switchRow} > svg`);
    const label = await box(`${switchRow} .assistant-options-label`);
    const track = await box(`${switchRow} .switch`);
    expect(row.height).toBe(52);
    await expect(page.locator(`${switchRow} .assistant-options-label`)).toHaveCSS(
      "font-weight",
      "400",
    );
    for (const part of [icon, label, track])
      expect(Math.abs(part.y + part.height / 2 - (row.y + row.height / 2))).toBeLessThan(
        1,
      );
    expect(icon.x - row.x).toBe(12);
    expect(row.x + row.width - (track.x + track.width)).toBe(12);
    const popover = await box(".assistant-options");
    const composer = await box(".assistant-composer");
    expect(composer.y - (popover.y + popover.height)).toBe(28);
  });

  test("a running team card in Settings uses the › glyph and insets its actions like its rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      assistants: [
        chatAssistant(),
        chatAssistant({
          id: "member-0",
          name: "Research lead",
          teamMemberId: "member-0",
        }),
      ],
      members: [
        {
          id: "member-0",
          kind: "member",
          teamId: "team",
          parentAssistantId: "home",
          assistantId: "member-0",
          name: "Research lead",
          role: "Research",
          assignment: "Compare vendors",
          lifetime: "task",
          phase: "running",
          conversationId: "member-chat",
        },
      ],
      teams: [
        {
          id: "team",
          revision: 1,
          parentAssistantId: "home",
          parentConversationId: "dinner",
          objective: "Prepare the relaunch",
          phase: "running",
          members: [],
          memberIds: ["member-0"],
        },
      ],
    });
    await page.goto(baseURL + "/agents/home/settings?tab=team");
    const card = page.locator(".assistant-team-card");
    const chevron = card.locator(":scope > summary .assistant-team-chevron");
    await expect(chevron).toHaveText("›");
    await expect(chevron).toHaveCSS("font-size", "22px");
    await card.locator(":scope > summary").click();
    await expect(chevron).toHaveCSS("transform", /matrix\(0, 1, -1, 0/);
    const [row, show, stop] = [
      await card.locator(".assistant-team-member").boundingBox(),
      await card.getByRole("link", { name: "Show in chat", exact: true }).boundingBox(),
      await card.getByRole("button", { name: "Stop team", exact: true }).boundingBox(),
    ];
    expect(show.x - row.x).toBe(8);
    expect(row.x + row.width - (stop.x + stop.width)).toBe(8);
    expect(Math.abs(show.height - stop.height)).toBeLessThanOrEqual(1);
  });

  test("the team chip draws its icon with the handoff's 1.8 stroke", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("switch").check();
    const icon = page
      .getByRole("button", { name: "Team allowed", exact: true })
      .locator("svg");
    await expect(icon).toHaveAttribute("stroke-width", "1.8");
  });
});
