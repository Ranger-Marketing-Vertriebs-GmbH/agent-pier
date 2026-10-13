import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import {
  expectNoHorizontalOverflow,
  openTab,
  profileList,
  revealRow,
} from "../helpers/extensions.js";
async function fixture(page) {
  const accounts = [
    { id: "local-codex", name: "Codex Lokal", tool: "codex", kind: "local" },
    { id: "managed-claude", name: "Claude Arbeit", tool: "claude", kind: "managed" },
  ];
  const writes = [];
  const data = {
    accountId: "local-codex",
    tool: "codex",
    mcp: {
      path: "/fixture/.codex/config.toml",
      servers: [],
      note: "Profilweite MCP-Konfiguration.",
    },
    skills: {
      installPath: "/fixture/.agents/skills",
      items: [
        {
          id: "read-only",
          name: "shared-skill",
          description: "Shared fixture",
          path: "/fixture/.agents/skills/shared",
          scope: "Benutzer · geteilt",
          removable: false,
        },
      ],
      note: "Benutzer · von Codex und kompatiblen CLIs geteilt.",
    },
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postDataJSON();
    if (method !== "GET") writes.push({ path: url.pathname, method, body });
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          accounts,
          tools: accounts.map((a) => ({ id: a.tool, name: a.tool, installed: true })),
          sessions: [],
          home: "/fixture",
        },
      });
    if (url.pathname.endsWith("/extensions")) return route.fulfill({ json: data });
    if (url.pathname.endsWith("/plugins"))
      return route.fulfill({
        json: {
          available: true,
          capabilities: {},
          installed: [],
          marketplaces: [],
          catalog: [],
        },
      });
    if (url.pathname === "/api/mcp-servers") return route.fulfill({ json: [] });
    if (url.pathname === "/api/mcp-servers/cli-finds")
      return route.fulfill({ json: { finds: [], problems: [] } });
    if (url.pathname.endsWith("/skills") && method === "POST") {
      const skill = {
        id: "installed",
        name: "demo-skill",
        description: "Installed fixture",
        path: "/fixture/.agents/skills/demo-skill",
        scope: "Benutzer · geteilt",
        removable: true,
      };
      data.skills.items.push(skill);
      return route.fulfill({ json: skill });
    }
    if (url.pathname.endsWith("/skills/installed") && method === "DELETE") {
      data.skills.items = data.skills.items.filter((s) => s.id !== "installed");
      return route.fulfill({ json: { removed: "installed" } });
    }
    return route.fulfill({ json: {} });
  });
  return { data, writes };
}
async function open(page) {
  await page.goto(base);
  if (await page.getByRole("button", { name: "Navigation öffnen" }).isVisible())
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await navigateTo(page, "Erweiterungen");
}
test("the MCP tab points to the central MCP server list", async ({ page }) => {
  const { writes } = await fixture(page);
  await open(page);
  await expect(
    page.getByRole("heading", { name: "Erweiterungen", level: 1 }),
  ).toBeVisible();
  const claude = profileList(page).getByRole("button", { name: /Claude Code/ });
  await claude.click();
  await expect(claude).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(/\/extensions\/managed-claude$/);
  await expect(page.getByRole("tab")).toHaveText(["MCP-Server", /^Skills/, /^Plugins/]);
  // Page margins sit on the frame, so the hover arrows line up with the tab row.
  const tabList = page.getByRole("tablist");
  const tabRow = await tabList.boundingBox();
  const tabFrame = await tabList.locator("..").boundingBox();
  expect(Math.round(tabRow.x)).toBe(Math.round(tabFrame.x));
  expect(Math.round(tabRow.y)).toBe(Math.round(tabFrame.y));
  await expect(
    page.getByText(/MCP-Server werden zentral unter Accounts → MCP-Server verwaltet/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "MCP-Server hinzufügen", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "MCP-Server öffnen", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\?section=mcp-servers$/);
  await expect(page.getByRole("region", { name: "In den CLIs gefunden" })).toBeVisible();
  expect(writes).toHaveLength(0);
});
test("skill file upload and GitHub download show native shared scope and protect existing skills", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await openTab(page, "Skills");
  await expect(page).toHaveURL(/\/extensions\/local-codex\?tab=skills$/);
  await expect(
    page.getByText(
      "Codex-Skills werden im Benutzerordner geteilt und gelten für alle Codex-Profile.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Skill shared-skill entfernen" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Skill installieren", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Skill installieren" });
  await expect(panel).toContainText("/fixture/.agents/skills");
  const sheet = await panel.boundingBox();
  expect(sheet.x).toBeGreaterThanOrEqual(0);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(390);
  // The side panel keeps its fixed 82dvh sheet, unlike content-sized dialogs.
  expect(Math.abs(sheet.height - 844 * 0.82)).toBeLessThanOrEqual(1);
  expect(Math.round(sheet.y + sheet.height)).toBe(844);
  await expectNoHorizontalOverflow(page);
  await panel.getByLabel("Skill-Datei").setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("---\nname: demo-skill\ndescription: Fixture\n---\nInstructions"),
  });
  await panel.getByRole("button", { name: "Skill installieren", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "demo-skill", exact: true }),
  ).toBeVisible();
  expect(Buffer.from(writes[0].body.contentBase64, "base64").toString()).toContain(
    "name: demo-skill",
  );
  await revealRow(page, "demo-skill");
  await page.getByRole("button", { name: "Skill demo-skill entfernen" }).click();
  await page.getByRole("button", { name: "Entfernen bestätigen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "demo-skill", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Skill installieren", exact: true }).click();
  await panel
    .getByRole("radiogroup", { name: "Skill-Quelle" })
    .getByRole("radio", { name: "GitHub-Link" })
    .check();
  await panel
    .getByLabel("Öffentlicher GitHub-Link")
    .fill("https://github.com/example/skills/tree/main/demo");
  await panel.getByRole("button", { name: "Skill installieren", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "demo-skill", exact: true }),
  ).toBeVisible();
  expect(writes.at(-1).body).toEqual({
    url: "https://github.com/example/skills/tree/main/demo",
  });
  await expectNoHorizontalOverflow(page);
});
for (const mobile of [false, true])
  test(`skills paginate and search all 50 entries${mobile ? " on mobile" : ""}`, async ({
    page,
  }) => {
    const { data, writes } = await fixture(page);
    data.skills.items = Array.from({ length: 50 }, (_, index) => ({
      id: `skill-${index + 1}`,
      name: `skill-${String(index + 1).padStart(2, "0")}`,
      description:
        index === 49
          ? "Einzigartige Beschreibung für Suche"
          : "Fixture skill description",
      path: `/fixture/.agents/skills/skill-${index + 1}`,
      scope: index === 48 ? "Projekt" : "Benutzer · geteilt",
      removable: false,
    }));
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await expect(page.getByRole("tab", { name: /^Skills/ })).toContainText("50");
    await openTab(page, "Skills");
    const section = page.getByRole("tabpanel");
    await expect(section.locator("article.extension-row")).toHaveCount(20);
    await expect(
      section.getByRole("heading", { name: "skill-01", exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("heading", { name: "skill-50", exact: true }),
    ).toHaveCount(0);
    await section
      .getByRole("button", { name: "Skills: Nächste Seite", exact: true })
      .click();
    await expect(
      section.getByRole("heading", { name: "skill-21", exact: true }),
    ).toBeVisible();
    await section
      .getByRole("button", { name: "Skills: Nächste Seite", exact: true })
      .click();
    await expect(section.locator("article.extension-row")).toHaveCount(10);
    await expect(
      section.getByRole("heading", { name: "skill-50", exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Skills: Nächste Seite", exact: true }),
    ).toBeDisabled();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("einzigartige");
    await expect(section.locator("article.extension-row")).toHaveCount(1);
    await expect(
      section.getByRole("heading", { name: "skill-50", exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Skills: Nächste Seite", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("Projekt");
    await expect(
      section.getByRole("heading", { name: "skill-49", exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("skill-47");
    await expect(
      section.getByRole("heading", { name: "skill-47", exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("nicht vorhanden");
    await expect(
      section.getByText("Keine Skills passen zur Suche.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("");
    await expect(section.locator("article.extension-row")).toHaveCount(20);
    await expect(
      section.getByRole("heading", { name: "skill-01", exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("skill-47");
    await profileList(page)
      .getByRole("button", { name: /Claude Code/ })
      .click();
    await expect(page).toHaveURL(/\/extensions\/managed-claude\?tab=skills$/);
    await expect(page.getByRole("searchbox", { name: "Skills suchen" })).toHaveValue("");
    await expect(
      section.getByRole("heading", { name: "skill-01", exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
