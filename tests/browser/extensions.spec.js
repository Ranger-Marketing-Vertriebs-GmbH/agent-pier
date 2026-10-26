import { openExtensions } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import {
  expectNoHorizontalOverflow,
  openProfiles,
  openTab,
  extensionRow,
  extensionTabList,
  profileList,
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
    if (url.pathname === "/api/accounts/usage")
      return route.fulfill({
        json: {
          agentsEnabled: false,
          connections: {},
          chatgpt: {},
          webSearch: null,
          speech: null,
          cliAccounts: {},
          mcpServers: {
            github: {
              agents: [],
              sessions: 0,
              pipelineProfiles: [],
              clis: [{ tool: "claude", route: null }],
            },
          },
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
    if (url.pathname.endsWith("/skills/preview") && method === "POST")
      return route.fulfill({
        json: {
          previewId: "preview-1",
          contentHash: "a".repeat(64),
          importKind: body.url ? "github" : "skill-md",
          name: "demo-skill",
          description: "Fixture",
          size: 60,
          files: [{ name: "SKILL.md", size: 60, executable: false }],
          verdict: "ok",
          rules: [],
          blocking: [],
          findings: [],
          truncated: false,
        },
      });
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
  await openExtensions(page);
}
test("the MCP reference row points to the central MCP server list", async ({ page }) => {
  const { writes } = await fixture(page);
  await open(page);
  await expect(
    page.getByRole("heading", { name: "CLIs & Erweiterungen", level: 1 }),
  ).toBeVisible();
  const claude = profileList(page).getByRole("button", { name: /Claude Code/ });
  await claude.click();
  await expect(claude).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(/\/coding\/clis\/extensions\/managed-claude$/);
  await expect(extensionTabList(page).getByRole("tab")).toHaveText([
    /^Skills/,
    /^Plugins/,
  ]);
  // Page margins sit on the frame, so the hover arrows line up with the tab row.
  const tabList = extensionTabList(page);
  const tabRow = await tabList.boundingBox();
  const tabFrame = await tabList.locator("..").boundingBox();
  expect(Math.round(tabRow.x)).toBe(Math.round(tabFrame.x));
  expect(Math.round(tabRow.y)).toBe(Math.round(tabFrame.y));
  const reference = page.getByRole("link", { name: /^MCP-Server · 1 für Claude Code/ });
  await expect(reference).toContainText("Zentral unter Zugänge");
  await expect(
    page.getByRole("button", { name: "MCP-Server hinzufügen", exact: true }),
  ).toHaveCount(0);
  await reference.click();
  await expect(page).toHaveURL(
    /\/connections\?section=mcp-servers&returnTo=%2Fcoding%2Fclis%2Fextensions%2F/,
  );
  await expect(
    page
      .getByRole("region", { name: "MCP-Server" })
      .getByRole("button", { name: /^In den CLIs gefunden/ }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});
test("skill file upload and GitHub download show native shared scope and protect existing skills", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await openTab(page, "Skills");
  await expect(page).toHaveURL(/\/coding\/clis\/extensions\/local-codex$/);
  await page.getByRole("button", { name: "Hinweis anzeigen", exact: true }).click();
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
  await panel.getByRole("button", { name: "Skill prüfen", exact: true }).click();
  await expect(panel.getByText("Unauffällig", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await panel.getByRole("button", { name: "Skill installieren", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(extensionRow(page, "demo-skill")).toBeVisible();
  expect(Buffer.from(writes[0].body.contentBase64, "base64").toString()).toContain(
    "name: demo-skill",
  );
  await expect(extensionRow(page, "demo-skill")).toBeVisible();
  await page.getByRole("button", { name: "Skill demo-skill entfernen" }).click();
  await page.getByRole("button", { name: "Jetzt entfernen", exact: true }).click();
  await expect(extensionRow(page, "demo-skill")).toHaveCount(0);
  await page.getByRole("button", { name: "Skill installieren", exact: true }).click();
  await panel
    .getByRole("radiogroup", { name: "Skill-Quelle" })
    .getByRole("radio", { name: "GitHub-Link" })
    .check();
  await panel
    .getByLabel("Öffentlicher GitHub-Link")
    .fill("https://github.com/example/skills/tree/main/demo");
  await panel.getByRole("button", { name: "Skill prüfen", exact: true }).click();
  await panel.getByRole("button", { name: "Skill installieren", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(extensionRow(page, "demo-skill")).toBeVisible();
  expect(writes.at(-2).body).toEqual({
    url: "https://github.com/example/skills/tree/main/demo",
  });
  expect(writes.at(-1).body).toEqual({
    previewId: "preview-1",
    contentHash: "a".repeat(64),
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
    const section = page.locator("#underline-tabpanel-skills");
    await expect(section.locator(".extension-list .list-row")).toHaveCount(20);
    await expect(extensionRow(section, "skill-01")).toBeVisible();
    await expect(extensionRow(section, "skill-50")).toHaveCount(0);
    await section
      .getByRole("button", { name: "Skills: Nächste Seite", exact: true })
      .click();
    await expect(extensionRow(section, "skill-21")).toBeVisible();
    await section
      .getByRole("button", { name: "Skills: Nächste Seite", exact: true })
      .click();
    await expect(section.locator(".extension-list .list-row")).toHaveCount(10);
    await expect(extensionRow(section, "skill-50")).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Skills: Nächste Seite", exact: true }),
    ).toBeDisabled();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("einzigartige");
    await expect(section.locator(".extension-list .list-row")).toHaveCount(1);
    await expect(extensionRow(section, "skill-50")).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Skills: Nächste Seite", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("Projekt");
    await expect(extensionRow(section, "skill-49")).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("skill-47");
    await expect(extensionRow(section, "skill-47")).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("nicht vorhanden");
    await expect(
      section.getByText("Keine Skills passen zur Suche.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("");
    await expect(section.locator(".extension-list .list-row")).toHaveCount(20);
    await expect(extensionRow(section, "skill-01")).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("skill-47");
    await (await openProfiles(page)).getByRole("button", { name: /Claude Code/ }).click();
    await expect(page).toHaveURL(/\/coding\/clis\/extensions\/managed-claude$/);
    await expect(page.getByRole("searchbox", { name: "Skills suchen" })).toHaveValue("");
    await expect(extensionRow(section, "skill-01")).toBeVisible();
    expect(writes).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
test("skill rows name the MCP package or the pinned GitHub commit they came from", async ({
  page,
}) => {
  const { data } = await fixture(page);
  data.skills.items.push(
    {
      id: "from-package",
      name: "reverse-it",
      description: "Package fixture",
      path: "/fixture/.agents/skills/reverse-it",
      scope: "Benutzer · geteilt",
      removable: true,
      package: { name: "rea-agents", version: "1.2.0" },
    },
    {
      id: "from-github",
      name: "pinned",
      description: "GitHub fixture",
      path: "/fixture/.agents/skills/pinned",
      scope: "Benutzer · geteilt",
      removable: true,
      origin: {
        kind: "github",
        repository: "example/skills",
        ref: "v1.2.0",
        refKind: "tag",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
    },
  );
  await open(page);
  await openTab(page, "Skills");
  await expect(extensionRow(page, "reverse-it")).toContainText(
    "Aus dem MCP-Paket rea-agents@1.2.0 · wird mit ihm aktualisiert und entfernt",
  );
  await expect(extensionRow(page, "pinned")).toContainText(
    "GitHub example/skills · Tag v1.2.0 · Commit 0123456789ab",
  );
});
