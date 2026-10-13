import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";
import { agentTab, settingsPath } from "../helpers/agent-settings-page.js";
import { openAccountItem } from "../helpers/accounts-browser.js";
import { navigateTo } from "../helpers/navigation.js";

// A page opened through a cross-link leads back to exactly where the owner came from;
// opened any other way it keeps its hierarchical back.
const copy = {
  en: {
    profile: "Profile",
    telegram: "Telegram",
    connections: /^Manage connections/,
    runtime: "Agent service settings",
    speech: /^Speech recognition · Deepgram/,
    backToAgent: "Back to Home",
    backToWorkspace: "Back to Workspace",
    menu: "Open navigation",
  },
  de: {
    profile: "Profil",
    telegram: "Telegram",
    connections: /^Zugänge verwalten/,
    runtime: "Agentendienst-Einstellungen",
    speech: /^Spracherkennung · Deepgram/,
    backToAgent: "Zurück zu Home",
    backToWorkspace: "Zurück zu Arbeitsbereich",
    menu: "Navigation öffnen",
  },
};
const sizes = {
  desktop: { width: 1440, height: 1000 },
  phone: { width: 390, height: 844 },
};
// The page's own scroll: the settings body on phones, the document on desktops.
const scrollOffset = (page) =>
  page.evaluate(
    () =>
      (document.querySelector(".assistant-settings-scroll")?.scrollTop || 0) +
      window.scrollY,
  );
const back = (page, name) => page.getByRole("button", { name, exact: true });

for (const [language, text] of Object.entries(copy))
  for (const [size, viewport] of Object.entries(sizes))
    test.describe(`cross-link back (${language}, ${size})`, () => {
      test.use({ viewport });

      test("Profile → Accounts returns to the agent's Profile tab", async ({ page }) => {
        await setup(page, { language });
        await page.setViewportSize({ width: viewport.width, height: 600 });
        await page.goto(baseURL + settingsPath());
        const link = page.getByRole("link", { name: text.connections });
        await link.scrollIntoViewIfNeeded();
        const offset = await scrollOffset(page);
        await link.click();
        await expect(page).toHaveURL(/\/accounts\?section=models&returnTo=/);
        // The origin survives a reload of the target page.
        await page.reload();
        await back(page, text.backToAgent).click();
        await expect(page).toHaveURL(/\/agents\/home\/settings$/);
        await expect(agentTab(page, text.profile)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect.poll(() => scrollOffset(page)).toBeGreaterThan(offset - 40);
        if (offset > 40) expect(await scrollOffset(page)).toBeLessThan(offset + 40);
      });

      test("agent service settings return to the agent", async ({ page }) => {
        await setup(page, { language });
        await page.goto(baseURL + settingsPath());
        await page.getByRole("link", { name: text.runtime }).first().click();
        await expect(page).toHaveURL(/\/settings\/assistants\?returnTo=/);
        await back(page, text.backToAgent).click();
        await expect(page).toHaveURL(/\/agents\/home\/settings$/);
        await expect(agentTab(page, text.profile)).toHaveAttribute(
          "aria-selected",
          "true",
        );
      });

      test("Telegram → Deepgram returns to the Telegram tab", async ({ page }) => {
        await setup(page, { language });
        await page.goto(baseURL + settingsPath("telegram"));
        await page.getByRole("link", { name: text.speech }).click();
        await expect(page).toHaveURL(
          /\/accounts\?section=services&item=speech&returnTo=/,
        );
        await back(page, text.backToAgent).click();
        await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=telegram$/);
        await expect(agentTab(page, text.telegram)).toHaveAttribute(
          "aria-selected",
          "true",
        );
      });

      test("pages opened directly keep their hierarchical back", async ({ page }) => {
        await setup(page, { language });
        await page.goto(baseURL + "/settings/assistants");
        await back(page, text.backToWorkspace).click();
        await expect(page).toHaveURL(/\/settings$/);
        await page.goto(baseURL + "/accounts?section=models");
        await expect(back(page, text.backToAgent)).toHaveCount(0);
        if (size === "phone")
          await expect(page.getByRole("button", { name: text.menu })).toBeVisible();
        // A forged origin is ignored rather than followed.
        await page.goto(
          baseURL +
            "/settings/assistants?returnTo=" +
            encodeURIComponent("//evil.test/x"),
        );
        await expect(page).toHaveURL(/\/settings\/assistants$/);
        await back(page, text.backToWorkspace).click();
        await expect(page).toHaveURL(/\/settings$/);
      });
    });

test("a cross-link's origin does not leak into later navigation", async ({ page }) => {
  await setup(page);
  await page.route("**/api/settings/summary", (route) =>
    route.fulfill({ json: { access: {}, operations: {} } }),
  );
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByRole("link", { name: copy.en.speech }).click();
  await expect(page).toHaveURL(/returnTo=/);
  // Leaving through the app's own navigation drops the origin, even within Accounts.
  await navigateTo(page, "Accounts");
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(back(page, copy.en.backToAgent)).toHaveCount(0);
  await navigateTo(page, "Settings");
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("tab", { name: "Access" }).click();
  await page.getByRole("link", { name: /^Provider access, MCP servers/ }).click();
  await expect(page).toHaveURL(/\/accounts\?returnTo=%2Fsettings%3Ftab%3Daccess$/);
  await back(page, "Back to Access").click();
  await expect(page).toHaveURL(/\/settings\?tab=access$/);
});

test.describe("cross-links on phones", () => {
  test.use({ viewport: sizes.phone });

  test("only the landing page leads to the origin; other entries go up", async ({
    page,
  }) => {
    await setup(page);
    await page.goto(baseURL + settingsPath());
    await page.getByRole("link", { name: copy.en.connections }).click();
    await expect(back(page, copy.en.backToAgent)).toBeVisible();
    await openAccountItem(page, "ChatGPT for agents");
    await expect(page).toHaveURL(/item=chatgpt&returnTo=/);
    await expect(back(page, copy.en.backToAgent)).toHaveCount(0);
    await back(page, "Back").click();
    await expect(page).toHaveURL(/\/accounts\?section=models&returnTo=/);
    await back(page, copy.en.backToAgent).click();
    await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  });

  test("a hub reached later keeps the menu", async ({ page }) => {
    await setup(page);
    await page.goto(baseURL + settingsPath("telegram"));
    await page.getByRole("link", { name: copy.en.speech }).click();
    await expect(back(page, copy.en.backToAgent)).toBeVisible();
    // An unknown entry returns to its group: a hub the link did not land on.
    await page.goto(
      baseURL +
        "/accounts?section=services&item=gone&returnTo=" +
        encodeURIComponent("/agents/home/settings?tab=telegram"),
    );
    await expect(page).toHaveURL(/\/accounts\?section=services&returnTo=/);
    await expect(page.getByRole("button", { name: copy.en.menu })).toBeVisible();
    await expect(back(page, copy.en.backToAgent)).toHaveCount(0);
  });

  test("history moves recompute the landing page", async ({ page }) => {
    await setup(page);
    await page.goto(baseURL + "/accounts?section=services");
    await expect(page.getByRole("button", { name: copy.en.menu })).toBeVisible();
    // Mounted without an origin, then moved through history onto a cross-link entry.
    await page.evaluate(
      (path) => {
        history.pushState(history.state, "", path);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      },
      "/accounts?section=services&item=speech&returnTo=" +
        encodeURIComponent("/agents/home/settings?tab=telegram"),
    );
    await expect(page.getByLabel("Deepgram API key")).toBeVisible();
    await back(page, copy.en.backToAgent).click();
    await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=telegram$/);
  });
});

test("Accounts on desktop keeps the origin for the whole visit", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByRole("link", { name: copy.en.speech }).click();
  await openAccountItem(page, "Web search");
  await expect(page).toHaveURL(/item=web-search&returnTo=/);
  await back(page, copy.en.backToAgent).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=telegram$/);
});

test("chained cross-links lead back through every origin", async ({ page }) => {
  await setup(page, { runtime: { availability: "failed", sync: "stale" } });
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByRole("link", { name: copy.en.speech }).click();
  const panel = await openAccountItem(page, "ChatGPT for agents");
  await panel.getByRole("link", { name: copy.en.runtime }).click();
  await expect(page).toHaveURL(/\/settings\/assistants\?returnTo=/);
  await page.reload();
  await back(page, "Back to Accounts").click();
  await expect(page).toHaveURL(/\/accounts\?section=models&item=chatgpt&returnTo=/);
  await back(page, copy.en.backToAgent).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=telegram$/);
});
