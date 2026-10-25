import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// A member's composer keeps one row, but its field must stay usable while the agent
// works: the German "Senden, wenn fertig" and "Stoppen" buttons wrap onto their own
// line instead of squeezing the field to a few pixels.
const shots = process.env.AGENTPIER_COMPOSER_SHOTS;
const working = [
  {
    id: "request-1",
    text: "Plan the week",
    state: "accepted",
    attempt: { id: "attempt-1", state: "accepted" },
  },
];

const setup = (language, requests) => ({
  language,
  assistants: [
    chatAssistant(),
    chatAssistant({
      id: "member-0",
      name: "Network Architect",
      teamMemberId: "member-0",
      teamId: "team",
      parentAssistantId: "home",
      lifetime: "task",
    }),
  ],
  conversations: [
    { id: "dinner", assistantId: "home" },
    { id: "member-chat", assistantId: "member-0" },
  ],
  history: { messages: [], requests, stale: false },
});

const chats = {
  member: "/agents/member-0/chats/member-chat",
  main: "/agents/home/chats/dinner",
};

const open = async (page, language, requests, chat = "member") => {
  await chatFixture(page, setup(language, requests));
  await page.goto(baseURL + chats[chat]);
  await expect(page.locator("#assistant-message")).toBeVisible();
};

const measure = (page) =>
  page.evaluate(() => {
    const box = document.querySelector(".assistant-composer-box").getBoundingClientRect();
    const field = document.querySelector("#assistant-message").getBoundingClientRect();
    return {
      box: box.width,
      field: field.width,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      boxOverflow:
        document.querySelector(".assistant-composer-box").scrollWidth - box.width,
    };
  });

for (const chat of ["member", "main"])
  for (const width of [375, 320]) {
    for (const [language, later, stop] of [
      ["de", "Senden, wenn fertig", "Stoppen"],
      ["en", "Send when done", "Stop"],
    ]) {
      test(`member ${chat} chat composer keeps its field wide while the agent works (${language}, ${width}px)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 700 });
        await open(page, language, working, chat);
        const field = page.locator("#assistant-message");
        await field.fill("Hallo");
        await expect(page.locator(".assistant-later")).toContainText(later);
        await expect(page.locator(".assistant-stop")).toContainText(stop);
        if (shots)
          await page
            .locator(".assistant-composer")
            .screenshot({ path: `${shots}/${chat}-${language}-${width}.png` });
        const idle = await measure(page);
        expect(idle.field).toBeGreaterThanOrEqual(idle.box * 0.6);
        expect(idle.overflow).toBeLessThanOrEqual(0);
        expect(idle.boxOverflow).toBeLessThanOrEqual(0);
        await field.fill("Eine längere Nachricht\nüber mehrere\nZeilen hinweg");
        const multi = await measure(page);
        expect(multi.field).toBeGreaterThanOrEqual(multi.box * 0.6);
      });
    }
  }

test("member composer keeps its field wide while the agent is idle", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page, "de", []);
  const sizes = await measure(page);
  expect(sizes.field).toBeGreaterThanOrEqual(sizes.box * 0.4);
  expect(sizes.overflow).toBeLessThanOrEqual(0);
});
