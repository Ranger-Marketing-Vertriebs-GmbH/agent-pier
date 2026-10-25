import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// A team member's chat on a phone: the role strip and the event area stay one slim
// row each, and both step aside while the on-screen keyboard is open (the composer
// has focus on a touch screen) so the transcript keeps its room.
const shots = process.env.AGENTPIER_STRIP_SHOTS;
test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });

const now = Date.now();
const events = Array.from({ length: 10 }, (_, n) => ({
  id: `routine:r${n}`,
  source: "routine",
  name: `Network check ${n + 1}`,
  at: now - (n + 1) * 60_000,
  status: n < 4 ? "failed" : "done",
  firstLine: n < 4 ? "" : "All links up",
}));
const words = {
  en: {
    group: "Events",
    unread: "10 new",
    failed: "4 failed",
    role: "Network & infrastructure specialist",
    assignment:
      "Manage and know the whole network topology, IP address plans, VLANs and firewalls.",
  },
  de: {
    group: "Ereignisse",
    unread: "10 neu",
    failed: "4 fehlgeschlagen",
    role: "Netzwerk- & Infrastruktur-Spezialist",
    assignment:
      "Verwalte und kenne die gesamte Netzwerk-Topologie, IP-Adresspläne, VLANs und Firewalls.",
  },
};

const setup = (language) => ({
  language,
  assistants: [
    chatAssistant(),
    chatAssistant({
      id: "member-0",
      name: "Network Architect",
      teamMemberId: "member-0",
      teamId: "team",
      parentAssistantId: "home",
      lifetime: "permanent",
    }),
  ],
  conversations: [
    { id: "dinner", assistantId: "home" },
    { id: "member-chat", assistantId: "member-0" },
  ],
  members: [
    {
      id: "member-0",
      kind: "member",
      teamId: "team",
      parentAssistantId: "home",
      assistantId: "member-0",
      name: "Network Architect",
      role: words[language].role,
      assignment: words[language].assignment,
      lifetime: "permanent",
      phase: "completed",
      conversationId: "member-chat",
    },
  ],
  history: {
    messages: [
      { id: "q", role: "user", text: "Is the Zabbix alert path tested?" },
      {
        id: "a",
        role: "assistant",
        text: "Alarm and all-clear up to Telegram were tested successfully.",
      },
    ],
    requests: [],
    events,
    stale: false,
  },
});

const open = async (page, language) => {
  await chatFixture(page, setup(language));
  await page.goto(baseURL + "/agents/member-0/chats/member-chat");
  await expect(page.locator(".agent-event-area")).toBeVisible();
};
const height = (locator) => locator.evaluate((e) => e.getBoundingClientRect().height);

for (const language of ["en", "de"])
  test(`member chat strips are one slim row each on a phone (${language})`, async ({
    page,
  }) => {
    const t = words[language];
    await open(page, language);
    const role = page.locator(".assistant-member-context");
    const area = page.locator(".agent-event-area");
    const head = page.locator(".agent-event-group > .activity-row-head");
    if (shots) await page.screenshot({ path: `${shots}/after-${language}.png` });
    await expect(role).toContainText(t.role);
    expect(await height(role)).toBeLessThanOrEqual(46);
    expect(await height(area)).toBeLessThanOrEqual(46);
    // The head stays a full touch target, without a frame of its own.
    expect(await height(head)).toBeGreaterThanOrEqual(40);
    await expect(page.locator(".agent-event-group")).toHaveCSS("border-top-width", "0px");
    // Short counts: the number, new events as a labelled dot, failures as the chip.
    await expect(head.locator(".activity-row-label")).toHaveText(t.group);
    await expect(head.locator(".activity-row-detail")).toHaveText("10");
    await expect(head.locator(".agent-event-unread")).toHaveAttribute(
      "aria-label",
      t.unread,
    );
    await expect(head.locator(".status-chip")).toHaveText(t.failed);
    // The head still opens and shuts the events.
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".agent-event-row")).toHaveCount(10);
    await expect(page.locator(".agent-event-row").first()).toBeVisible();
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".agent-event-row").first()).toBeHidden();
  });

for (const language of ["en", "de"])
  test(`the strips step aside while the composer has focus on a touch screen (${language})`, async ({
    page,
  }) => {
    await open(page, language);
    const role = page.locator(".assistant-member-context");
    const area = page.locator(".agent-event-area");
    const field = page.locator("#assistant-message");
    const transcript = page.locator(".assistant-transcript");
    const before = await height(transcript);
    await field.tap();
    await expect(field).toBeFocused();
    await expect(role).toBeHidden();
    await expect(area).toBeHidden();
    expect(await height(transcript)).toBeGreaterThan(before + 80);
    if (shots) await page.screenshot({ path: `${shots}/after-${language}-focused.png` });
    await field.blur();
    await expect(role).toBeVisible();
    await expect(area).toBeVisible();
    // An event area the owner opened stays while typing.
    await page.locator(".agent-event-group > .activity-row-head").click();
    await field.tap();
    await expect(field).toBeFocused();
    await expect(role).toBeHidden();
    await expect(area).toBeVisible();
  });

test("the strips stay while the composer has focus on a wide screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, "en");
  await page.locator("#assistant-message").focus();
  await expect(page.locator(".assistant-member-context")).toBeVisible();
  await expect(page.locator(".agent-event-area")).toBeVisible();
});
