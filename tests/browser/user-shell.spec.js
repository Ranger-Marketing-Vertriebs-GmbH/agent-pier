import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { userAppFixture } from "../helpers/user-app-fixture.js";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = [
  [
    "de",
    {
      menu: "Menü",
      agents: "Meine Agenten",
      account: "Konto",
      signOut: "Abmelden",
      missing: "Diese Seite gibt es hier nicht.",
      toAgents: "Zu meinen Agenten",
    },
  ],
  [
    "en",
    {
      menu: "Menu",
      agents: "My agents",
      account: "Account",
      signOut: "Sign out",
      missing: "This page does not exist here.",
      toAgents: "Go to my agents",
    },
  ],
];

for (const [language, copy] of languages) {
  test(`user shell navigates between my agents and account at 390px (${language})`, async ({
    page,
  }) => {
    const state = await userAppFixture(page, { language });
    await page.goto(baseURL + "/agents");
    await page.getByRole("button", { name: copy.menu, exact: true }).click();
    const menu = page.getByRole("dialog", { name: copy.menu });
    await menu.getByRole("button", { name: copy.account, exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(
      page.getByRole("heading", { level: 1, name: copy.account }),
    ).toBeVisible();
    // Back returns to her agents; the browser's back goes to the account again.
    await page.getByRole("button", { name: /Zurück|Back/ }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/account$/);
    await page.getByRole("button", { name: copy.menu, exact: true }).click();
    await menu.getByRole("button", { name: copy.agents, exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    // An owner page pasted into her app leads nowhere but back to her agents.
    await page.goto(baseURL + "/settings/users");
    await expect(page.getByText(copy.missing)).toBeVisible();
    await page.getByRole("button", { name: copy.toAgents }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await page.getByRole("button", { name: copy.menu, exact: true }).click();
    await menu.getByRole("button", { name: copy.signOut, exact: true }).click();
    await expect(page.getByRole("heading", { name: /Anmelden|Sign in/ })).toBeVisible();
    expect(state.signedOut).toBe(true);
    expect(state.foreign).toEqual([]);
  });
}
