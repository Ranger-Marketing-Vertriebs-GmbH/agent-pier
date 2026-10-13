import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// AGENTPIER-68: a lead's composer offers its members after "@"; a sent mention is a
// chip that opens the member's chat. "Max" and "Max Ops" share a prefix; Keeper is
// archived and cannot be mentioned.
const shots = process.env.MEMBER_MENTION_SHOTS;
const viewports = {
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 1000 } },
};
const words = {
  en: { hi: "Hi", list: "Team members", permanent: "Permanent", temporary: "Temporary" },
  de: {
    hi: "Hallo",
    list: "Teammitglieder",
    permanent: "Dauerhaft",
    temporary: "Temporär",
  },
};
const member = (id, name, lifetime, overrides) =>
  chatAssistant({
    id,
    name,
    teamMemberId: id,
    teamId: "infra",
    parentAssistantId: "home",
    lifetime,
    ...overrides,
  });
const record = (id, role, lifetime) => ({
  id,
  kind: "member",
  revision: 1,
  teamId: "infra",
  parentAssistantId: "home",
  assistantId: id,
  role,
  assignment: `${role} work`,
  lifetime,
  phase: "completed",
  conversationId: `${id}-chat`,
});
const sent = {
  en: "@Network Architect add the new NAS to the docs",
  de: "@Network Architect trag den neuen NAS in die Doku ein",
};
const live = "@max ops check the backups, @Max reads along";

function setup(page, language, history) {
  return chatFixture(page, {
    language,
    assistants: [
      chatAssistant(),
      member("net", "Network Architect", "permanent"),
      member("max", "Max", "task"),
      member("ops", "Max Ops", "permanent"),
      member("keeper", "Keeper", "permanent", { archivedAt: "2026-10-01T00:00:00Z" }),
    ],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "net-chat", assistantId: "net" },
      { id: "max-chat", assistantId: "max" },
      { id: "ops-chat", assistantId: "ops" },
    ],
    members: [
      record("net", "Infrastructure", "permanent"),
      record("max", "Research", "task"),
      record("ops", "Operations", "permanent"),
      record("keeper", "Archive", "permanent"),
    ],
    ...(history ? { history } : {}),
  });
}
const fits = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);

for (const language of ["en", "de"])
  for (const [label, device] of Object.entries(viewports))
    test.describe(`member mentions (${language}, ${label})`, () => {
      const w = words[language];
      test.use(device);

      test("@ opens the lead's members, filters and inserts by keyboard", async ({
        page,
      }) => {
        await setup(page, language);
        await page.goto(baseURL + "/agents/home/chats/dinner");
        const field = page.getByRole("combobox");
        const list = page.getByRole("listbox", { name: w.list });
        await expect(field).toHaveAttribute("aria-expanded", "false");
        await expect(list).toBeHidden();
        await expect(page.locator(".assistant-message").first()).toBeVisible();
        await field.fill(`${w.hi} `);
        await field.press("End");
        await field.pressSequentially("@");
        await expect(list).toBeVisible();
        await expect(field).toHaveAttribute("aria-expanded", "true");
        const options = list.getByRole("option");
        await expect(options).toHaveCount(3);
        await expect(list).not.toContainText("Keeper");
        const net = options.filter({ hasText: "Network Architect" });
        await expect(net).toContainText("Infrastructure");
        await expect(net.locator(".member-mention-badge")).toHaveText(w.permanent);
        await expect(
          options.filter({ hasText: "Research" }).locator(".member-mention-badge"),
        ).toHaveText(w.temporary);
        await fits(page);
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/autocomplete-${label}.png` });
        // Filters as you type; the longer name follows the exact one.
        await field.pressSequentially("ma");
        await expect(options).toHaveText([/^Max\s*Research/, /^Max Ops/]);
        await expect(options.first()).toHaveAttribute("aria-selected", "true");
        await expect(field).toHaveAttribute(
          "aria-activedescendant",
          (await options.first().getAttribute("id")) || "",
        );
        await field.press("ArrowDown");
        await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
        await field.press("Enter");
        await expect(field).toHaveValue(`${w.hi} @Max Ops `);
        await expect(list).toBeHidden();
        await expect(field).toBeFocused();
        // Escape closes without inserting; Tab picks.
        await field.pressSequentially("und @net");
        await expect(options).toHaveCount(1);
        await field.press("Escape");
        await expect(list).toBeHidden();
        await expect(field).toHaveValue(`${w.hi} @Max Ops und @net`);
        await field.pressSequentially(" @Netw");
        await field.press("Tab");
        await expect(field).toHaveValue(`${w.hi} @Max Ops und @net @Network Architect `);
        // A typed whole name is complete: Enter sends, it does not pick "Max Ops".
        await field.fill("");
        await field.pressSequentially("@Max ");
        await expect(list).toBeHidden();
      });

      test("a tap or click on a member inserts its exact name", async ({ page }) => {
        await setup(page, language);
        await page.goto(baseURL + "/agents/home/chats/dinner");
        const field = page.getByRole("combobox");
        await field.pressSequentially("@ARCH");
        const option = page.getByRole("option", { name: /Network Architect/ });
        if (label === "phone") await option.tap();
        else await option.click();
        await expect(field).toHaveValue("@Network Architect ");
        await expect(page.getByRole("listbox", { name: w.list })).toBeHidden();
        await field.pressSequentially("trag den NAS ein");
        await expect(field).toHaveValue("@Network Architect trag den NAS ein");
      });

      test("sent mentions are chips to the member's chat, in history and live", async ({
        page,
      }) => {
        await setup(page, language, {
          messages: [{ id: "q", role: "user", text: sent[language] }],
          requests: [
            {
              id: "now",
              text: live,
              createdAt: new Date().toISOString(),
              attempt: { id: "a", state: "running" },
            },
          ],
          stale: false,
        });
        await page.goto(baseURL + "/agents/home/chats/dinner");
        const history = page
          .locator(".assistant-message.user")
          .filter({ hasText: "NAS" });
        const chip = history.getByRole("link", { name: "@Network Architect" });
        await expect(chip).toHaveAttribute("href", "/agents/net/chats/net-chat");
        await expect(chip).toHaveClass(/member-mention-chip/);
        await expect(history.locator(".message-content")).toHaveText(sent[language]);
        // Live: the longest name wins, in any case.
        const current = page
          .locator(".assistant-message.user")
          .filter({ hasText: "backups" });
        await expect(current.locator(".member-mention-chip")).toHaveText([
          "@max ops",
          "@Max",
        ]);
        await expect(current.getByRole("link", { name: "@max ops" })).toHaveAttribute(
          "href",
          "/agents/ops/chats/ops-chat",
        );
        await fits(page);
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/chips-${label}.png` });
        if (label === "phone") await chip.tap();
        else await chip.click();
        await expect(page).toHaveURL(/\/agents\/net\/chats\/net-chat$/);
        // A member's chat has no autocomplete.
        await expect(page.getByRole("combobox")).toHaveCount(0);
        await expect(page.getByRole("listbox", { name: w.list })).toHaveCount(0);
      });
    });
