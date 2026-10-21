import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

// The owner's audit log names who acted, at 390px in German and English.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const event = (id, values) => ({
  id: String(id),
  createdAt: "2026-10-20T10:00:00.000Z",
  outcome: "success",
  resourceType: "assistant",
  resourceId: "a1",
  ...values,
});
const languages = {
  de: {
    heading: "Aktivitätsprotokoll",
    user: "von Anna K",
    owner: "von dir (Besitzer)",
    deleted: "von einem gelöschten Benutzer",
  },
  en: {
    heading: "Activity log",
    user: "by Anna K",
    owner: "by you (owner)",
    deleted: "by a deleted user",
  },
};

for (const [language, copy] of Object.entries(languages))
  test(`audit entries name the acting user or the owner (${language})`, async ({
    page,
  }) => {
    const state = await operationsFixture(page);
    await page.addInitScript(
      (value) => localStorage.setItem("agentpier-language", value),
      language,
    );
    state.events = [
      event(3, {
        action: "assistant.settings.updated",
        source: "user",
        actorUserId: "u1",
        actorName: "Anna K",
        details: { fields: ["name"] },
      }),
      event(2, { action: "user.updated", source: "user", resourceType: "user" }),
      event(1, {
        action: "assistant.settings.updated",
        source: "user",
        actorUserId: "u2",
        actorName: null,
      }),
    ];
    await page.goto(baseURL + "/settings/audit");
    await expect(
      page.getByRole("heading", { name: copy.heading, exact: true }),
    ).toBeVisible();
    const entries = page.getByRole("article");
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText(copy.user);
    await expect(entries.nth(1)).toContainText(copy.owner);
    await expect(entries.nth(2)).toContainText(copy.deleted);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
