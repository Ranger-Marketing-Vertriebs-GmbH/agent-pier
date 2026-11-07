import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// A team member's chat on a phone: the role strip stays one slim row and steps aside
// while the on-screen keyboard is open (the composer has focus on a touch screen) so
// the transcript keeps its room. The events sit in the header (AgentEventsButton).
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
  await expect(eventsButton(page)).toBeVisible();
};
const eventsButton = (page) => page.locator(".assistant-header .agent-chat-events");
const height = (locator) => locator.evaluate((e) => e.getBoundingClientRect().height);

for (const language of ["en", "de"])
  test(`member chat strips are one slim row each on a phone (${language})`, async ({
    page,
  }) => {
    const t = words[language];
    await open(page, language);
    const role = page.locator(".assistant-member-context");
    const head = eventsButton(page);
    if (shots) await page.screenshot({ path: `${shots}/after-${language}.png` });
    await expect(role).toContainText(t.role);
    expect(await height(role)).toBeLessThanOrEqual(46);
    // The events take no row: a header icon at the header's touch size.
    expect(await height(head)).toBeGreaterThanOrEqual(40);
    // Short counts: the number, new and failed events as a labelled dot.
    await expect(head).toHaveAttribute("aria-label", `${t.group}: 10`);
    await expect(head.locator(".agent-chat-events-count")).toHaveText("10");
    await expect(head.locator(".agent-chat-events-unread")).toHaveAttribute(
      "aria-label",
      `${t.unread} · ${t.failed}`,
    );
    // The button opens the events in a sheet, which closes again.
    await head.click();
    const sheet = page.getByRole("dialog", { name: t.group });
    await expect(sheet.locator(".agent-event-row")).toHaveCount(10);
    await expect(sheet.locator(".agent-event-row").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

for (const language of ["en", "de"])
  test(`the strips step aside while the composer has focus on a touch screen (${language})`, async ({
    page,
  }) => {
    await open(page, language);
    const role = page.locator(".assistant-member-context");
    const field = page.locator("#assistant-message");
    const transcript = page.locator(".assistant-transcript");
    const before = await height(transcript);
    await field.tap();
    await expect(field).toBeFocused();
    await expect(role).toBeHidden();
    await expect(eventsButton(page)).toBeVisible();
    expect(await height(transcript)).toBeGreaterThan(before + 40);
    if (shots) await page.screenshot({ path: `${shots}/after-${language}-focused.png` });
    await field.blur();
    await expect(role).toBeVisible();
  });

test("the strips stay while the composer has focus on a wide screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, "en");
  await page.locator("#assistant-message").focus();
  await expect(page.locator(".assistant-member-context")).toBeVisible();
  await expect(eventsButton(page)).toBeVisible();
});
