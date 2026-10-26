import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";
import { agentTab, settingsPath } from "../helpers/agent-settings-page.js";
import { openAccountItem } from "../helpers/accounts-browser.js";
import { navigateTo } from "../helpers/navigation.js";
import { connectionsFixture, mcpServer } from "./connections-fixture.js";

// A page opened through a cross-link leads back to exactly where the owner came from;
// opened any other way it keeps its hierarchical back.
const copy = {
  en: {
    identity: "Identity",
    overview: "Overview",
    channels: "Channels",
    connections: /^Manage connections/,
    runtime: "Agent service settings",
    speech: /^Speech recognition · Deepgram/,
    backToAgent: "Back to Home",
    backToWorkspace: "Back to General",
    menu: "Open navigation",
  },
  de: {
    identity: "Identität",
    overview: "Überblick",
    channels: "Kanäle",
    connections: /^Zugänge verwalten/,
    runtime: "Agentendienst-Einstellungen",
    speech: /^Spracherkennung · Deepgram/,
    backToAgent: "Zurück zu Home",
    backToWorkspace: "Zurück zu Allgemein",
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

      test("Identity → Zugänge returns to the agent's Identity tab", async ({ page }) => {
        await setup(page, { language });
        await page.setViewportSize({ width: viewport.width, height: 600 });
        await page.goto(baseURL + settingsPath("identity"));
        const link = page.getByRole("link", { name: text.connections });
        await link.scrollIntoViewIfNeeded();
        const offset = await scrollOffset(page);
        await link.click();
        await expect(page).toHaveURL(/\/connections\?section=models&returnTo=/);
        // The origin survives a reload of the target page.
        await page.reload();
        await back(page, text.backToAgent).click();
        await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=identity$/);
        await expect(agentTab(page, text.identity)).toHaveAttribute(
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
        await expect(page).toHaveURL(/\/agents\?tab=runtime&returnTo=/);
        await back(page, text.backToAgent).click();
        await expect(page).toHaveURL(/\/agents\/home\/settings$/);
        await expect(agentTab(page, text.overview)).toHaveAttribute(
          "aria-selected",
          "true",
        );
      });

      test("Channels → Deepgram returns to the Channels tab", async ({ page }) => {
        await setup(page, { language });
        await page.goto(baseURL + settingsPath("telegram"));
        await page.getByRole("link", { name: text.speech }).click();
        await expect(page).toHaveURL(
          /\/connections\?section=services&item=speech&returnTo=/,
        );
        await back(page, text.backToAgent).click();
        await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=channels$/);
        await expect(agentTab(page, text.channels)).toHaveAttribute(
          "aria-selected",
          "true",
        );
      });

      test("pages opened directly keep their hierarchical back", async ({ page }) => {
        await setup(page, { language });
        // Agenten › Laufzeit is a top-level page: opened directly it has no back arrow.
        await page.goto(baseURL + "/settings/assistants");
        await expect(page).toHaveURL(/\/agents\?tab=runtime$/);
        await expect(back(page, text.backToWorkspace)).toHaveCount(0);
        await expect(back(page, text.backToAgent)).toHaveCount(0);
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
        await expect(page).toHaveURL(/\/agents\?tab=runtime$/);
        await expect(back(page, text.backToAgent)).toHaveCount(0);
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
  await navigateTo(page, "Connections");
  await expect(page).toHaveURL(/\/connections$/);
  await expect(back(page, copy.en.backToAgent)).toHaveCount(0);
  await navigateTo(page, "Settings");
  await expect(page).toHaveURL(/\/settings$/);
  // The Access tab moved to Zugänge: its old address carries no origin either.
  await expect(page.getByRole("tab", { name: "Access" })).toHaveCount(0);
  await page.goto(baseURL + "/settings?tab=access");
  await expect(page).toHaveURL(/\/connections$/);
  await expect(back(page, "Back to Access")).toHaveCount(0);
});

test.describe("cross-links on phones", () => {
  test.use({ viewport: sizes.phone });

  test("only the landing page leads to the origin; other entries go up", async ({
    page,
  }) => {
    await setup(page);
    await page.goto(baseURL + settingsPath("identity"));
    await page.getByRole("link", { name: copy.en.connections }).click();
    await expect(back(page, copy.en.backToAgent)).toBeVisible();
    await openAccountItem(page, "ChatGPT for agents");
    await expect(page).toHaveURL(/item=chatgpt&returnTo=/);
    await expect(back(page, copy.en.backToAgent)).toHaveCount(0);
    await back(page, "Back to Model access").click();
    await expect(page).toHaveURL(/\/connections\?section=models&returnTo=/);
    await back(page, copy.en.backToAgent).click();
    await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=identity$/);
  });

  test("a list reached later goes up to the categories", async ({ page }) => {
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
    await expect(page).toHaveURL(/\/connections\?section=services&returnTo=/);
    // On phones a category's list is a subpage of the categories.
    await expect(back(page, "Connections")).toBeVisible();
    await expect(back(page, copy.en.backToAgent)).toHaveCount(0);
  });

  test("history moves recompute the landing page", async ({ page }) => {
    await setup(page);
    await page.goto(baseURL + "/accounts?section=services");
    await expect(back(page, "Connections")).toBeVisible();
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
    await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=channels$/);
  });
});

test("Accounts on desktop keeps the origin for the whole visit", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByRole("link", { name: copy.en.speech }).click();
  await openAccountItem(page, "Web search");
  await expect(page).toHaveURL(/item=web-search&returnTo=/);
  await back(page, copy.en.backToAgent).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=channels$/);
});

test("chained cross-links lead back through every origin", async ({ page }) => {
  await setup(page, { runtime: { availability: "failed", sync: "stale" } });
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByRole("link", { name: copy.en.speech }).click();
  const panel = await openAccountItem(page, "ChatGPT for agents");
  await panel.getByRole("link", { name: copy.en.runtime }).click();
  await expect(page).toHaveURL(/\/agents\?tab=runtime&returnTo=/);
  await page.reload();
  await back(page, "Back to Connections").click();
  await expect(page).toHaveURL(/\/connections\?section=models&item=chatgpt&returnTo=/);
  await back(page, copy.en.backToAgent).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=channels$/);
});

// AC-RT-2: an entry opened from the agent's Access tab leads back to that tab, also
// after a reload of the Zugänge page.
for (const [size, viewport] of Object.entries(sizes))
  test(`Access → Zugänge item returns to the Access tab (${size})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await connectionsFixture(page, {
      hosts: 1,
      assistant: { mcpServers: ["docs"] },
      mcpServers: [mcpServer("docs", "Docs")],
    });
    await page.goto(baseURL + settingsPath("access"));
    await expect(agentTab(page, "Access")).toHaveAttribute("aria-selected", "true");
    const open = page.getByRole("link", { name: "Open Docs in Connections" });
    await open.click();
    await expect(page).toHaveURL(
      /\/connections\?section=mcp-servers&item=docs&returnTo=/,
    );
    await page.reload();
    // The entry opens: its detail pane on desktops, its own subpage on phones.
    await expect(
      page.getByRole("heading", { name: "Docs", exact: true }).last(),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Used by", level: 2 })).toBeVisible();
    await back(page, copy.en.backToAgent).click();
    await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=access$/);
    await expect(agentTab(page, "Access")).toHaveAttribute("aria-selected", "true");
    await expect(open).toBeVisible();
  });
