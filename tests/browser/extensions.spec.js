import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
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
    if (url.pathname.endsWith("/mcp") && method === "POST") {
      data.mcp.servers.push({
        name: body.name,
        transport: body.transport,
        command: body.command || "",
        url: body.url ? "https://example.invalid" : "",
        argumentCount: body.args?.length || 0,
        environmentKeys: Object.keys(body.env || {}),
        headerKeys: Object.keys(body.headers || {}),
        enabled: true,
        source: data.mcp.path,
      });
      return route.fulfill({ json: data.mcp });
    }
    if (url.pathname.includes("/mcp/") && method === "DELETE") {
      data.mcp.servers = [];
      return route.fulfill({ json: data.mcp });
    }
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
  await navigateTo(page, "MCP & Skills");
}
test("MCP configuration is account-scoped, preserves secrets only in request and can be removed", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await open(page);
  await page.getByRole("combobox", { name: "CLI-Profil" }).selectOption("managed-claude");
  await page.getByText("MCP-Server hinzufügen", { exact: true }).click();
  await page.getByLabel("MCP-Name").fill("fixture");
  await page.getByLabel("Befehl", { exact: true }).fill("fixture-command");
  await page.getByLabel("Argumente als JSON").fill('["--token","private-argument"]');
  await page
    .getByLabel("Umgebungsvariablen als JSON")
    .fill('{"API_KEY":"private-token"}');
  await page.getByRole("button", { name: "MCP speichern", exact: true }).click();
  await expect(page.getByRole("heading", { name: "fixture", exact: true })).toBeVisible();
  expect(writes[0].path).toBe("/api/accounts/managed-claude/extensions/mcp");
  expect(writes[0].body.env.API_KEY).toBe("private-token");
  await expect(page.getByLabel("Umgebungsvariablen als JSON")).toHaveValue("{}");
  await expect(page.getByText("private-token", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "MCP fixture entfernen" }).click();
  await page.getByRole("button", { name: "Entfernen bestätigen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "fixture", exact: true })).toHaveCount(
    0,
  );
});
test("skill file upload and GitHub download show native shared scope and protect existing skills", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(
    page.getByText(
      "Codex-Skills werden im Benutzerordner geteilt und gelten für alle Codex-Profile.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Skill shared-skill entfernen" }),
  ).toHaveCount(0);
  await page.getByLabel("Skill-Datei").setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("---\nname: demo-skill\ndescription: Fixture\n---\nInstructions"),
  });
  await page.getByRole("button", { name: "Skill installieren", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "demo-skill", exact: true }),
  ).toBeVisible();
  expect(Buffer.from(writes[0].body.contentBase64, "base64").toString()).toContain(
    "name: demo-skill",
  );
  await page.getByRole("button", { name: "Skill demo-skill entfernen" }).click();
  await page.getByRole("button", { name: "Entfernen bestätigen", exact: true }).click();
  await page.getByRole("combobox", { name: "Skill-Quelle" }).selectOption("url");
  await page
    .getByLabel("Öffentlicher GitHub-Link")
    .fill("https://github.com/example/skills/tree/main/demo");
  await page.getByRole("button", { name: "Skill installieren", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "demo-skill", exact: true }),
  ).toBeVisible();
  expect(writes.at(-1).body).toEqual({
    url: "https://github.com/example/skills/tree/main/demo",
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
});
test("failed MCP writes preserve the draft and never submit twice while pending", async ({
  page,
}) => {
  await fixture(page);
  await open(page);
  await page.getByText("MCP-Server hinzufügen", { exact: true }).click();
  await page.getByLabel("MCP-Name").fill("remote");
  await page.getByRole("combobox", { name: "Verbindung" }).selectOption("http");
  await page.getByLabel("MCP-URL").fill("https://example.invalid/mcp");
  let release;
  let calls = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/extensions/mcp", async (route) => {
    calls++;
    await held;
    await route.fulfill({
      status: 409,
      json: { error: "Konfiguration gleichzeitig geändert" },
    });
  });
  await page.getByRole("button", { name: "MCP speichern", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "MCP wird gespeichert …" }),
  ).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText(
    "Konfiguration gleichzeitig geändert",
  );
  await expect(page.getByLabel("MCP-URL")).toHaveValue("https://example.invalid/mcp");
  expect(calls).toBe(1);
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
    const section = page.getByRole("region", { name: "Skills", exact: true });
    await expect(section.locator("article.extension-card")).toHaveCount(20);
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
    await expect(section.locator("article.extension-card")).toHaveCount(10);
    await expect(
      section.getByRole("heading", { name: "skill-50", exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Skills: Nächste Seite", exact: true }),
    ).toBeDisabled();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("einzigartige");
    await expect(section.locator("article.extension-card")).toHaveCount(1);
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
    await expect(section.locator("article.extension-card")).toHaveCount(20);
    await expect(
      section.getByRole("heading", { name: "skill-01", exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Skills suchen" }).fill("skill-47");
    await page
      .getByRole("combobox", { name: "CLI-Profil" })
      .selectOption("managed-claude");
    await expect(page.getByRole("searchbox", { name: "Skills suchen" })).toHaveValue("");
    await expect(
      section.getByRole("heading", { name: "skill-01", exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  });
