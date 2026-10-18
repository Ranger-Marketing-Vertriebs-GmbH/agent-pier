import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { extensionsPageFixture } from "../helpers/extensions-page-fixture.js";
import {
  expectNoHorizontalOverflow,
  extensionRow,
  openTab,
} from "../helpers/extensions.js";

const mcpLink = (page) => page.getByRole("link", { name: /^MCP-Server · / });
const profileColumn = (page) =>
  page.getByRole("navigation", { name: "CLI-Profile", exact: true });

test("legacy MCP links open Skills and the reference row counts central servers", async ({
  page,
}) => {
  const fixture = await extensionsPageFixture(page, { holdUsage: true });
  await page.goto(`${base}/extensions/local-codex?tab=mcp`);
  await expect(page).toHaveURL(/\/extensions\/local-codex$/);
  await expect(page.getByRole("tab")).toHaveText([
    /^Skills/,
    /^Plugins/,
    /^Marketplaces/,
  ]);
  await expect(page.getByRole("tab", { name: /^Skills/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Unknown until the usage summary arrives: never a made-up 0.
  await expect(mcpLink(page)).toContainText("— für Codex");
  fixture.releaseUsage();
  await expect(mcpLink(page)).toContainText("1 für Codex");
  await expect(mcpLink(page)).toContainText("Zentral unter Accounts");
  await profileColumn(page)
    .getByRole("button", { name: /Claude Code/ })
    .click();
  await expect(page).toHaveURL(/\/extensions\/managed-claude$/);
  await expect(mcpLink(page)).toContainText("2 für Claude Code");
  await openTab(page, "Plugins");
  await expect(mcpLink(page)).toBeVisible();
  await openTab(page, "Marketplaces");
  await expect(mcpLink(page)).toHaveCount(0);
  await openTab(page, "Skills");
  await mcpLink(page).click();
  await expect(page).toHaveURL(
    /\/accounts\?section=mcp-servers&returnTo=%2Fextensions%2Fmanaged-claude$/,
  );
  expect(fixture.writes).toEqual([]);
});

test("old and junk extension addresses normalise once to one canonical address", async ({
  page,
}) => {
  await extensionsPageFixture(page);
  for (const [from, to] of [
    ["/plugins/local-codex", /\/extensions\/local-codex\?tab=plugins$/],
    ["/extensions/local-codex?tab=skills", /\/extensions\/local-codex$/],
    ["/extensions/local-codex?tab=bogus", /\/extensions\/local-codex$/],
    ["/extensions/local-codex?tab=agents", /\/extensions\/local-codex$/],
    [
      "/extensions/local-codex?tab=marketplaces",
      /\/extensions\/local-codex\?tab=marketplaces$/,
    ],
  ]) {
    await page.goto(base + from);
    await expect(page).toHaveURL(to);
  }
  // Normalisation replaces the entry instead of stacking a new one.
  const before = await page.evaluate(() => history.length);
  await page.goto(`${base}/extensions/local-codex?tab=mcp`);
  await expect(page).toHaveURL(/\/extensions\/local-codex$/);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
});

test("the ⓘ on the Codex skills label discloses the scope note verbatim", async ({
  page,
}) => {
  await extensionsPageFixture(page);
  await page.goto(`${base}/extensions/local-codex`);
  const text =
    "Codex-Skills werden im Benutzerordner geteilt und gelten für alle Codex-Profile.";
  const hint = page.getByRole("button", { name: "Hinweis anzeigen", exact: true });
  await expect(hint).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(text, { exact: true })).toBeHidden();
  await hint.click();
  await expect(hint).toHaveAttribute("aria-expanded", "true");
  const controlled = page.locator(`[id="${await hint.getAttribute("aria-controls")}"]`);
  await expect(controlled).toHaveText(text);
  await expect(controlled).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await hint.click();
  await expect(controlled).toBeHidden();
  // The server's own skills note stays visible; other CLIs have no scope hint.
  await expect(
    page.getByText(
      /^Benutzer · von Codex und kompatiblen CLIs geteilt\. Angezeigt werden/,
    ),
  ).toBeVisible();
  await page.goto(`${base}/extensions/managed-claude`);
  await expect(extensionRow(page, "project-review")).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test("extensions never show a save bar or ask to save on tab, profile or history changes", async ({
  page,
}) => {
  await extensionsPageFixture(page);
  let prompted = false;
  page.on("dialog", (dialog) => {
    prompted = true;
    dialog.dismiss();
  });
  await page.goto(`${base}/extensions/local-codex`);
  const bar = page.getByRole("region", { name: "Ungespeicherte Änderungen" });
  const sheet = page.getByRole("dialog", { name: "Änderungen speichern?" });
  await page.getByRole("searchbox", { name: "Skills suchen" }).fill("review");
  for (const tab of ["Plugins", "Marketplaces", "Skills"]) {
    await openTab(page, tab);
    await expect(bar).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
  }
  await profileColumn(page)
    .getByRole("button", { name: /Claude Code/ })
    .click();
  await expect(page).toHaveURL(/\/extensions\/managed-claude$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/extensions\/local-codex$/);
  await expect(sheet).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  await page.reload();
  await expect(extensionRow(page, "project-review")).toBeVisible();
  expect(prompted).toBe(false);
});

test("desktop keeps the primary action and config path in the detail header", async ({
  page,
}) => {
  await extensionsPageFixture(page);
  await page.goto(`${base}/extensions/managed-claude?tab=marketplaces`);
  const header = page.locator(".extension-hub-header");
  await expect(header).toContainText("Claude Code · /fixture/.claude/settings.json");
  const add = page.getByRole("button", { name: "Marketplace hinzufügen", exact: true });
  await expect(add).toHaveCount(1);
  await expect(
    header.getByRole("button", { name: "Marketplace hinzufügen" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^CLI-Profil wechseln/ })).toBeHidden();
  const market = extensionRow(page, "official");
  await expect(market).toContainText("Eigene Quelle · 1 Plugins");
  await market.getByRole("button", { name: "Aktionen für official" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Aktualisieren", "Entfernen"]);
  // The fixed menu ends at its trigger's right edge, scrollbar or not.
  const trigger = await market
    .getByRole("button", { name: "Aktionen für official" })
    .boundingBox();
  const box = await menu.boundingBox();
  expect(Math.abs(box.x + box.width - (trigger.x + trigger.width))).toBeLessThanOrEqual(
    1,
  );
});

test("a failed or empty usage summary keeps the MCP count unknown", async ({ page }) => {
  for (const failUsage of ["error", "empty"]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await extensionsPageFixture(page, { failUsage });
    await page.goto(`${base}/extensions/local-codex`);
    await expect(extensionRow(page, "project-review")).toBeVisible();
    await expect(mcpLink(page)).toContainText("— für Codex");
    await expect(mcpLink(page)).not.toContainText("0 für Codex");
  }
});

// Visible headings (sr-only ones included) never skip a level, e.g. h1 → h3.
const headingLevels = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("main h1, main h2, main h3, main h4")]
      .filter((node) => node.checkVisibility())
      .map((node) => Number(node.tagName[1])),
  );
const expectNoSkippedHeading = async (page) => {
  const levels = await headingLevels(page);
  expect(levels[0]).toBe(1);
  levels.forEach((level, i) => {
    if (i) expect(level - levels[i - 1], levels.join(" ")).toBeLessThanOrEqual(1);
  });
};

test("phones: headings keep their order and Marketplaces offer the ⋯ menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await extensionsPageFixture(page);
  await page.goto(`${base}/extensions/managed-claude`);
  await expect(extensionRow(page, "project-review")).toBeVisible();
  await expectNoSkippedHeading(page);
  // "+ Skill installieren": the "+" keeps its distance from the label.
  const action = page.locator(".group-label-action");
  expect(await action.evaluate((node) => getComputedStyle(node).columnGap)).toBe("4px");
  await openTab(page, "Plugins");
  await extensionRow(page, "superpowers")
    .getByRole("button", { name: /^superpowers/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "superpowers", exact: true }),
  ).toBeVisible();
  await expectNoSkippedHeading(page);
  await page.getByRole("button", { name: "Zurück zu Plugins" }).click();
  await openTab(page, "Marketplaces");
  const market = extensionRow(page, "official");
  await market.getByRole("button", { name: "Aktionen für official" }).click();
  const menu = page.getByRole("menu", { name: "Aktionen für official" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Aktualisieren", "Entfernen"]);
  const box = await menu.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // The global mobile header is hidden here, so the update notice must not leave room for it.
  const top = await page.evaluate(() => {
    const notice = document.createElement("div");
    notice.className = "update-notice";
    document.body.append(notice);
    const value = getComputedStyle(notice).top;
    notice.remove();
    return value;
  });
  expect(top).toBe("8px");
  await expectNoHorizontalOverflow(page);
});

test("desktop plugin rows offer Details and actions behind ⋯ with keyboard support", async ({
  page,
}) => {
  const fixture = await extensionsPageFixture(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/extensions/managed-claude?tab=plugins`);
  const row = extensionRow(page, "superpowers");
  await expect(row).toContainText("Aktiv");
  const trigger = row.getByRole("button", {
    name: "Aktionen für superpowers",
    exact: true,
  });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Aktionen für superpowers" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Details",
    "Deaktivieren",
    "Aktualisieren",
    "Entfernen",
  ]);
  const box = await menu.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Plugin superpowers deaktivieren" }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Plugin superpowers entfernen" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  // An outside press closes the menu; the page title is inert, unlike the sidebar corner.
  await page.getByRole("heading", { name: "Erweiterungen", level: 1 }).click();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Plugin superpowers deaktivieren" }).click();
  await expect(row).toContainText("Deaktiviert");
  expect(fixture.writes.at(-1).body).toEqual({
    action: "disable",
    pluginId: "superpowers@official",
  });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Details zu superpowers" }).click();
  await expect(
    page.getByRole("heading", { name: "superpowers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("4.1.0", { exact: true })).toBeVisible();
  await expect(page.getByText("/fixture/.claude/plugins/superpowers")).toBeVisible();
  // The detail is a subpage: no list note, reload or MCP reference row above or below it.
  await expect(mcpLink(page)).toHaveCount(0);
  await expect(page.locator(".plugin-topbar")).toHaveCount(0);
  await page.getByRole("button", { name: "Zurück zu Plugins" }).click();
  await expect(row).toBeVisible();
  // Back returns focus to the row that opened the detail, not to <body>.
  await expect(row.getByRole("button", { name: /^superpowers/ })).toBeFocused();
  await expect(mcpLink(page)).toBeVisible();
  // Near the bottom edge the menu opens above its trigger instead of leaving the viewport.
  const rowBox = await row.boundingBox();
  const height = Math.ceil(rowBox.y + rowBox.height + 24);
  await page.setViewportSize({ width: 1280, height });
  await trigger.click();
  await expect(menu).toBeVisible();
  const low = await menu.boundingBox();
  expect(low.y).toBeGreaterThanOrEqual(0);
  expect(low.y + low.height).toBeLessThanOrEqual(height);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("removing a plugin from its detail view returns to the list", async ({ page }) => {
  await extensionsPageFixture(page);
  await page.goto(`${base}/extensions/managed-claude?tab=plugins`);
  await extensionRow(page, "superpowers")
    .getByRole("button", { name: /^superpowers/ })
    .click();
  await page.getByRole("button", { name: "Plugin superpowers entfernen" }).click();
  await page.getByRole("button", { name: "Jetzt entfernen", exact: true }).click();
  const empty = page.getByText("Noch keine Plugins installiert.", { exact: true });
  await expect(empty).toBeVisible();
  await expect(page.getByRole("button", { name: "Zurück zu Plugins" })).toHaveCount(0);
  await expect(empty).toBeFocused();
});

test("phones: sidebar button, profile sheet, plugin detail and a locked switcher", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await extensionsPageFixture(page, { holdPluginWrites: true });
  await page.goto(`${base}/extensions/local-codex`);
  await expect(page.locator(".mobile-header")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Erweiterungen", level: 1 }),
  ).toBeVisible();
  await expect(profileColumn(page)).toBeHidden();
  await page
    .getByRole("button", { name: /^CLI-Profil wechseln, aktuell Codex Lokal/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "CLI-Profile" });
  const profiles = sheet.getByRole("group", { name: "CLI-Profile" }).getByRole("button");
  await expect(profiles).toHaveCount(2);
  await expect(profiles.filter({ hasText: "Codex Lokal" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(sheet).toContainText("/fixture/.codex/config.toml");
  await profiles.filter({ hasText: "Claude Arbeit" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/extensions\/managed-claude$/);
  await expect(
    page.getByRole("button", { name: "Skill installieren", exact: true }),
  ).toHaveCount(1);
  await openTab(page, "Plugins");
  const row = extensionRow(page, "superpowers");
  await expect(
    row.getByRole("button", { name: "Aktionen für superpowers" }),
  ).toBeHidden();
  await row.getByRole("button", { name: /^superpowers/ }).click();
  await expect(
    page.getByRole("heading", { name: "superpowers", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Plugin superpowers deaktivieren" }).click();
  const switcher = page.getByRole("button", { name: /^CLI-Profil wechseln/ });
  await expect(switcher).toBeDisabled();
  await expect(page.getByRole("tab", { name: /^Skills/ })).toBeDisabled();
  fixture.releaseWrites();
  await expect(
    page.getByRole("button", { name: "Plugin superpowers aktivieren" }),
  ).toBeVisible();
  await expect(switcher).toBeEnabled();
  await page.getByRole("button", { name: "Zurück zu Plugins" }).click();
  await expect(row).toContainText("Deaktiviert");
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await expectNoHorizontalOverflow(page);
});

test.describe("in English", () => {
  test.use({ locale: "en-GB" });
  test("the Skills tab translates the skill scope and its visibility notice", async ({
    page,
  }) => {
    await extensionsPageFixture(page);
    await page.goto(`${base}/extensions/local-codex`);
    await expect(
      page.getByText(
        "User · shared by Codex and compatible CLIs. Known user and profile folders are shown; project- and plugin-specific skills are not fully covered. Only skills installed here can be removed.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(extensionRow(page, "project-review")).toContainText(
      "User · shared by Codex and compatible CLIs · Installed here",
    );
    await expect(page.locator(".extension-tabpanel")).not.toContainText(
      /Benutzer|Angezeigt/,
    );
  });
  test("shared profiles show four tabs, the profile sheet and the reference row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await extensionsPageFixture(page, { shared: true });
    await page.goto(`${base}/extensions/local-claude?tab=agents`);
    await expect(page.getByRole("tab")).toHaveText([
      /^Skills/,
      /^Plugins/,
      /^Marketplaces/,
      /^Agents/,
    ]);
    const agents = page.getByRole("tab", { name: /^Agents/ });
    await expect(agents).toHaveAttribute("aria-selected", "true");
    await expect(agents).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Browse catalog", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /^Switch CLI profile, current: Claude Code/ })
      .click();
    const sheet = page.getByRole("dialog", { name: "CLI profiles" });
    await expect(
      sheet.getByRole("group", { name: "CLI profiles" }).getByRole("button"),
    ).toHaveText([
      /Codex.*All accounts using this CLI/,
      /Claude Code.*All accounts using this CLI/,
    ]);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await openTab(page, "Skills");
    await expect(
      page.getByRole("link", { name: /^MCP servers · 2 for Claude Code/ }),
    ).toContainText("Managed centrally in Accounts");
    await expectNoHorizontalOverflow(page);
  });
});
